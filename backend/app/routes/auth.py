"""Authentication endpoints (SIWE → JWT cookie).

Per docs/api-spec.md §2:

* ``POST /api/v1/auth/nonce``   — issue a single-use SIWE nonce bound to the
  caller-declared ``address`` (rate 30/min/IP). Security #5: the body MUST
  contain ``{"address": "0x..."}`` — the issued nonce is only redeemable by
  a SIWE message signed for that exact address. This defeats the
  pre-harvesting attack where an attacker accumulates nonces and re-uses
  them in a phishing flow against a different victim.
* ``POST /api/v1/auth/verify``  — verify SIWE message + signature, set
  ``pt_session`` cookie (rate 10/min/IP).
* ``POST /api/v1/auth/logout``  — clear ``pt_session`` cookie (no rate-limit;
  unauthenticated callers also receive 204 — see §2.3).

Cookie spec (§2.4):

* Name: ``pt_session``
* Value: HS256 JWT (see :mod:`shared.jwt`).
* ``HttpOnly``, ``SameSite=Lax``, ``Path=/``.
* ``Secure`` controlled by ``app.config["SESSION_COOKIE_SECURE"]`` — defaults
  to ``False`` so HTTP-only dev works; production must set it via
  ``SESSION_COOKIE_SECURE=1``.
* ``Max-Age = 72 * 3600`` (72h) per §2.2.
"""

from __future__ import annotations

import re
import time
from typing import Any

from flask import Blueprint, current_app, jsonify, request

from app.deps import SESSION_COOKIE
from app.errors import abort_with_problem
from app.limits import limiter
from shared import jwt as jwt_mod
from shared.siwe import (
    NONCE_TTL_SEC,
    ExpiredMessage,
    InvalidDomain,
    InvalidNonce,
    InvalidSignature,
    SiweError,
    make_nonce,
    verify_message,
)

bp = Blueprint("auth", __name__)

_COOKIE_MAX_AGE_SEC = 72 * 3600


# ─── /auth/nonce ────────────────────────────────────────────────────────────

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


@bp.post("/api/v1/auth/nonce")
@limiter.limit("30 per minute")
def post_nonce() -> Any:
    """Issue a fresh SIWE nonce bound to the caller-declared ``address``.

    Body per §2.1: ``{ "address": "0x..." }``.
    Response: ``{ "nonce", "issuedAt", "expiresAt" }``. TTL 5 minutes.

    Security #5: the nonce is only redeemable by a SIWE message whose
    ``address`` field matches the one supplied here. An attacker who
    pre-harvests nonces (e.g. by spamming this endpoint) cannot redeem them
    on behalf of a different victim because :func:`shared.siwe._consume_nonce_atomic`
    matches on ``(nonce, address)``.
    """

    payload = request.get_json(silent=True) or {}
    address = payload.get("address")

    if not isinstance(address, str) or not _ADDRESS_RE.match(address):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="Body must contain a valid 0x-prefixed 40-hex 'address' field",
        )

    assert isinstance(address, str)  # for mypy
    address_lower = address.lower()

    nonce = make_nonce(address_lower)
    issued_at = int(time.time())
    return jsonify(
        {
            "nonce": nonce,
            "issuedAt": issued_at,
            "expiresAt": issued_at + NONCE_TTL_SEC,
        }
    )


# ─── /auth/verify ───────────────────────────────────────────────────────────

_SIWE_ERROR_TITLES = {
    "auth.siwe.invalid_signature": "Invalid SIWE signature",
    "auth.siwe.invalid_nonce": "Invalid or expired nonce",
    "auth.siwe.invalid_domain": "SIWE domain mismatch",
    "auth.siwe.expired_message": "SIWE message expired",
}


def _extract_address_from_message(message: str) -> str | None:
    """Best-effort address extraction for the SIWE message (line 2 by spec).

    Used as the ``expected_address`` arg of :func:`verify_message`. The verifier
    itself re-parses the message and binds the recovered signer to this address;
    extracting it here only saves the caller from having to send it separately
    in the request body.
    """

    try:
        lines = message.splitlines()
        if len(lines) < 2:
            return None
        candidate = lines[1].strip()
        if not (candidate.startswith("0x") and len(candidate) == 42):
            return None
        return candidate.lower()
    except Exception:
        return None


@bp.post("/api/v1/auth/verify")
@limiter.limit("10 per minute")
def post_verify() -> Any:
    """Verify SIWE message + signature, set the ``pt_session`` cookie.

    Errors map to api-spec §1.4 codes via :class:`shared.siwe.SiweError`
    subclasses. All SIWE failures are 401 ``application/problem+json``.
    """

    payload = request.get_json(silent=True) or {}
    message = payload.get("message")
    signature = payload.get("signature")

    if not isinstance(message, str) or not isinstance(signature, str):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="Body must contain string fields 'message' and 'signature'",
        )

    assert isinstance(message, str) and isinstance(signature, str)  # for mypy

    expected_address = _extract_address_from_message(message)
    if expected_address is None:
        abort_with_problem(
            code="auth.siwe.invalid_signature",
            title=_SIWE_ERROR_TITLES["auth.siwe.invalid_signature"],
            status=401,
            detail="Could not extract address from SIWE message",
        )

    assert expected_address is not None

    try:
        verify_message(message, signature, expected_address)
    except (InvalidNonce, InvalidDomain, ExpiredMessage, InvalidSignature) as exc:
        abort_with_problem(
            code=exc.code,
            title=_SIWE_ERROR_TITLES.get(exc.code, "Authentication failed"),
            status=401,
            detail=str(exc) or None,
        )
    except SiweError as exc:
        # Catch-all for any subclass we forgot to enumerate.
        abort_with_problem(
            code=exc.code,
            title=_SIWE_ERROR_TITLES.get(exc.code, "Authentication failed"),
            status=401,
            detail=str(exc) or None,
        )

    token = jwt_mod.encode(expected_address)

    secure = bool(current_app.config.get("SESSION_COOKIE_SECURE", False))
    response = jsonify({"address": expected_address})
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=_COOKIE_MAX_AGE_SEC,
        httponly=True,
        secure=secure,
        samesite="Lax",
        path="/",
    )
    return response


# ─── /auth/logout ───────────────────────────────────────────────────────────


@bp.post("/api/v1/auth/logout")
def post_logout() -> Any:
    """Clear the ``pt_session`` cookie. Always 204 (idempotent, unauthenticated)."""

    secure = bool(current_app.config.get("SESSION_COOKIE_SECURE", False))
    response = current_app.response_class(status=204)
    # Clear by sending an empty value with Max-Age=0; mirrors the original
    # cookie attributes so browsers actually overwrite the existing cookie.
    response.set_cookie(
        SESSION_COOKIE,
        "",
        max_age=0,
        httponly=True,
        secure=secure,
        samesite="Lax",
        path="/",
    )
    return response


__all__ = ["bp"]
