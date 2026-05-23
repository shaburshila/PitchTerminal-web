"""SIWE (EIP-4361) nonce issuance + message verification.

Per docs/api-spec.md §2.1-§2.2:

* :func:`make_nonce` — generate a 16+ alphanumeric nonce, INSERT into
  ``auth_nonces``, return the value. The DB column has ``created_at DEFAULT now()``
  which fixes the TTL clock to the server, not the worker.

* :func:`verify_message` — parse the SIWE message via the upstream ``siwe``
  library, then enforce the server-side policy listed in §2.2:

  1. ``domain == config.siwe_domain``
  2. ``uri == config.siwe_uri``
  3. ``chain_id == 8453`` (Base mainnet)
  4. ``nonce`` exists in ``auth_nonces`` AND age <= ``NONCE_TTL_SEC`` (5 min)
  5. ``expiration_time`` (if present) is in the future
  6. ``address.lower() == expected_address.lower()``
  7. ECDSA signature recovers to ``address`` (EOA-only — see note below)

  On success the nonce row is DELETEd (single-use).

  Each precondition failure raises a specific subclass of :class:`SiweError`
  carrying the api-spec ``code`` for problem+json serialization.

**Smart-contract wallets (EIP-1271).** The upstream ``siwe`` library supports
EIP-1271 via a ``provider`` arg to ``SiweMessage.verify``, but it requires a
live RPC for the on-chain ``isValidSignature`` call and an HTTPProvider, not
the AsyncWeb3 we use elsewhere. For MVP B0.10 we only verify EOA signatures;
EIP-1271 is tracked as TODO and will land in a follow-up step once smart
wallets become a non-trivial fraction of users.
"""

from __future__ import annotations

import secrets
import string
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

import siwe as _siwe  # type: ignore[import-untyped]
from eth_account import Account
from eth_account.messages import encode_defunct

from shared.db import execute, fetch_one

# 5 minutes per api-spec §2.1.
NONCE_TTL_SEC = 5 * 60
# Upper bound on `expirationTime - issuedAt`. Spec §2.2 caps the message
# validity window at 5 minutes (matches the nonce TTL).
EXPIRATION_MAX_SEC = 5 * 60
# Tolerance for `issuedAt`-in-the-future check: wallet clock can drift, so a
# small forward window (30s) is allowed.
ISSUED_AT_FUTURE_TOLERANCE_SEC = 30
# Required statement per api-spec §2.2 — must match exactly (prevents a
# phishing site from injecting "Approve transfer of 1000 USDC" while keeping
# our domain/uri/chain_id intact).
REQUIRED_STATEMENT = "Sign in to PitchTerminal."
_BASE_CHAIN_ID = 8453

_ALPHABET = string.ascii_letters + string.digits


# ─── Error hierarchy ────────────────────────────────────────────────────────


class SiweError(Exception):
    """Base SIWE-verification error. ``code`` matches api-spec §1.4 catalog."""

    code: str = "auth.siwe.invalid_signature"


class InvalidSignature(SiweError):
    code = "auth.siwe.invalid_signature"


class InvalidNonce(SiweError):
    code = "auth.siwe.invalid_nonce"


class InvalidDomain(SiweError):
    code = "auth.siwe.invalid_domain"


class ExpiredMessage(SiweError):
    code = "auth.siwe.expired_message"


# ─── Nonce issuance ────────────────────────────────────────────────────────


def _generate_token(length: int = 16) -> str:
    """Cryptographically-strong alphanumeric token (default 16 chars)."""

    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def make_nonce() -> str:
    """Generate a fresh nonce and INSERT into ``auth_nonces``.

    Retries on the (astronomically unlikely) PK collision; returns the value
    after a successful insert.
    """

    # PK collision in 16-char alnum is ~1 in 62^16; one extra attempt is
    # plenty of paranoia.
    for _ in range(3):
        nonce = _generate_token(16)
        rows = execute(
            "INSERT INTO auth_nonces (nonce) VALUES (%s) ON CONFLICT DO NOTHING",
            (nonce,),
        )
        if rows:
            return nonce
    # Extremely unlikely to reach; raise to surface a real DB problem.
    raise RuntimeError("Failed to issue a SIWE nonce after retries")


# ─── Verification ──────────────────────────────────────────────────────────


def _consume_nonce_atomic(nonce: str) -> None:
    """Atomically consume the nonce if it exists and is <5 min old.

    Critical (review K, finding C-1): the previous SELECT-then-DELETE pattern
    left a TOCTOU race window where two concurrent ``verify_message`` calls
    on the same nonce could both pass the SELECT check before either DELETE
    ran — both would then issue valid JWTs. The atomic
    ``DELETE ... RETURNING`` resolves this at the SQL level: exactly one
    transaction wins, the loser sees ``rowcount == 0``.

    We call this **before** signature recovery so an attacker who knows a
    valid nonce can't burn CPU on recovery attempts for a nonce that has
    already been consumed.

    Raises:
        InvalidNonce: nonce missing, already consumed, or expired.
    """

    cutoff = datetime.now(UTC) - timedelta(seconds=NONCE_TTL_SEC)
    row = fetch_one(
        "DELETE FROM auth_nonces WHERE nonce = %s AND created_at > %s "
        "RETURNING created_at",
        (nonce, cutoff),
    )
    if row is None:
        # Either the row was never there, was consumed by a concurrent
        # request, or is stale. We also clean up stale rows opportunistically
        # so the table doesn't accumulate noise (the worker has a periodic
        # cleanup too — this is just a fast-path).
        execute("DELETE FROM auth_nonces WHERE nonce = %s", (nonce,))
        raise InvalidNonce("Nonce unknown, already consumed, or expired")


def _recover_signer(message_text: str, signature: str) -> str | None:
    """Recover the EOA address that signed ``message_text`` via EIP-191.

    Returns lowercase address, or ``None`` if recovery fails.
    """

    try:
        encoded = encode_defunct(text=message_text)
        recovered = Account.recover_message(encoded, signature=signature)
        return str(recovered).lower()
    except Exception:
        return None


def verify_message(
    message: str,
    signature: str,
    expected_address: str,
    *,
    siwe_domain: str | None = None,
    siwe_uri: str | None = None,
) -> None:
    """Verify a SIWE message against ``expected_address``.

    Args:
        message: Raw EIP-4361 message text the client signed.
        signature: 0x-prefixed hex signature (65 bytes — r||s||v).
        expected_address: Address the client claims; compared case-insensitively.
        siwe_domain: Override of ``config.siwe_domain`` (test injection).
        siwe_uri: Override of ``config.siwe_uri`` (test injection).

    Raises:
        InvalidDomain: domain/uri/chain do not match server policy.
        InvalidNonce: nonce missing, expired, or already used.
        ExpiredMessage: ``expirationTime`` claim is in the past.
        InvalidSignature: parse error, recovery failure, or recovered address
            does not match ``expected_address``.

    On success the nonce is consumed (single-use).
    """

    # Lazy-load config to keep this module import-safe for unit tests that
    # patch env vars after import.
    if siwe_domain is None or siwe_uri is None:
        from shared.config import config

        if siwe_domain is None:
            siwe_domain = config.siwe_domain
        if siwe_uri is None:
            siwe_uri = config.siwe_uri

    # 1) Parse.
    try:
        parsed = _siwe.SiweMessage.from_message(message)
    except Exception as exc:
        raise InvalidSignature(f"Malformed SIWE message: {exc!s}") from exc

    # 2) Domain/URI/chain policy (single error code per spec §1.4).
    if parsed.domain != siwe_domain:
        raise InvalidDomain(f"Domain mismatch: {parsed.domain!r} != {siwe_domain!r}")
    # H-4 fix (review K): canonicalize URIs before comparing — pydantic may
    # normalize the parsed URI (e.g. add a trailing slash). Compare by
    # (scheme, host, path) tuple after stripping trailing slashes on path.
    if not _uris_equivalent(str(parsed.uri), siwe_uri):
        raise InvalidDomain(f"URI mismatch: {str(parsed.uri)!r} != {siwe_uri!r}")
    if int(parsed.chain_id) != _BASE_CHAIN_ID:
        raise InvalidDomain(f"Chain mismatch: {parsed.chain_id} != {_BASE_CHAIN_ID}")

    # 3) Statement — spec §2.2 requires exact match. Without this an attacker
    # controlling a malicious front-end on our domain could inject phishing
    # text into the wallet prompt while keeping domain/uri/chain valid.
    if parsed.statement != REQUIRED_STATEMENT:
        raise InvalidDomain(
            f"Statement mismatch — expected exactly {REQUIRED_STATEMENT!r}"
        )

    # 4) Address binding.
    if parsed.address.lower() != expected_address.lower():
        raise InvalidSignature("Address in SIWE message does not match claimant")

    # 5) Time-based validity (review K, H-2 and H-3).
    now = datetime.now(UTC)
    issued_at = _parse_iso_datetime(parsed.issued_at)
    if issued_at is None:
        # SIWE spec mandates issuedAt; the siwe library should reject earlier.
        raise InvalidSignature("SIWE message missing issuedAt")
    if issued_at > now + timedelta(seconds=ISSUED_AT_FUTURE_TOLERANCE_SEC):
        raise ExpiredMessage("SIWE issuedAt is in the future")
    not_before = _parse_iso_datetime(getattr(parsed, "not_before", None))
    if not_before is not None and not_before > now:
        raise ExpiredMessage("SIWE notBefore is in the future")
    if parsed.expiration_time is not None:
        exp_dt = _parse_iso_datetime(parsed.expiration_time)
        if exp_dt is None:
            raise InvalidSignature("SIWE message expirationTime unparseable")
        if exp_dt <= now:
            raise ExpiredMessage("SIWE message expirationTime has passed")
        # H-2: enforce upper bound `exp ≤ issuedAt + 5min` so a single signature
        # can't be replayed forever — even if the nonce TTL is later changed.
        if (exp_dt - issued_at) > timedelta(seconds=EXPIRATION_MAX_SEC):
            raise ExpiredMessage(
                f"SIWE expirationTime exceeds {EXPIRATION_MAX_SEC}s window from issuedAt"
            )

    # 6) Nonce — C-1 (review K): atomic DELETE+check happens BEFORE signature
    # recovery to close the TOCTOU window. If two concurrent requests carry
    # the same nonce, exactly one wins this DELETE; the other gets
    # InvalidNonce immediately without touching the (expensive) signature
    # recovery path.
    _consume_nonce_atomic(parsed.nonce)

    # 7) Signature — EOA recovery. If this fails, the nonce is already
    # consumed (we could re-issue, but that's the user's responsibility — they
    # just retry the whole /auth flow).
    recovered = _recover_signer(parsed.prepare_message(), signature)
    if recovered is None or recovered != parsed.address.lower():
        # TODO(B-future): EIP-1271 fallback for smart-contract wallets.
        raise InvalidSignature("Signature does not recover to claimed address")


def _uris_equivalent(a: str, b: str) -> bool:
    """True if ``a`` and ``b`` are the same URI modulo trailing-slash on path.

    EIP-4361 § 4 says URI must match exactly, but pydantic (used by the siwe
    library) normalizes URLs in subtle ways (adds trailing slash to empty
    path, lowercases scheme). We canonicalize both sides before comparing
    so a legitimate ``https://pitchterminal.app`` doesn't get rejected
    because the parsed form became ``https://pitchterminal.app/``.
    """

    pa, pb = urlsplit(a), urlsplit(b)
    return (
        pa.scheme.lower() == pb.scheme.lower()
        and pa.netloc.lower() == pb.netloc.lower()
        and pa.path.rstrip("/") == pb.path.rstrip("/")
        and pa.query == pb.query
    )


def _parse_iso_datetime(value: object) -> datetime | None:
    """Best-effort ISO-8601 parser for SIWE timestamp fields.

    The upstream library may expose timestamps as a wrapping type (with a
    ``_datetime`` attr) or as a plain ISO string. ``None`` → ``None``.
    """

    if value is None:
        return None
    inner = getattr(value, "_datetime", None)
    if isinstance(inner, datetime):
        dt = inner
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except (TypeError, ValueError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt


__all__ = [
    "NONCE_TTL_SEC",
    "ExpiredMessage",
    "InvalidDomain",
    "InvalidNonce",
    "InvalidSignature",
    "SiweError",
    "make_nonce",
    "verify_message",
]
