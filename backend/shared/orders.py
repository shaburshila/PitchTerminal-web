"""Limit-order helpers — schemas, EIP-712 verification, quote-token validation.

Per docs/api-spec.md §7 + docs/eip712.md §2-3 + docs/plans/backend.md B2.1:

* :class:`OrderIn` — payload of ``POST /api/v1/orders`` (camelCase JSON).
* :class:`OrderOut` — list/detail response shape (api-spec §7.1).
* :class:`OrderStatus` / :class:`OrderSide` / :class:`OrderVenue` — string enums
  matching the Postgres ``ENUM`` types from ``docs/db-schema.sql``.
* :func:`compute_order_digest` — EIP-712 digest of the canonical ``Order`` struct.
  Same bytes Solidity's ``_hashOrder``/``_digest`` produce. Required for the
  IC-2.1 cross-check ritual described in docs/eip712.md §7.
* :func:`verify_order_signature` — ECDSA recovery + EIP-1271 fallback (smart
  wallets). Returns ``True`` if ``signature`` is a valid signature of
  ``compute_order_digest`` by ``owner``.
* :func:`validate_quote_token` — per docs/eip712.md §3.3 + functional-spec §7:
  player-venue ⇒ ``quoteToken == country_address`` of the player token;
  country-venue ⇒ ``quoteToken == PITCH``. The server checks this *before*
  storing the order so a typo in the front never reaches the chain.

Module is strict-mypy clean (it lives under ``shared/``).
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Any, Literal

from eth_account.messages import encode_typed_data
from eth_typing import ChecksumAddress, HexStr
from eth_utils.address import to_checksum_address
from hexbytes import HexBytes
from pydantic import BaseModel, ConfigDict, Field, field_validator
from web3 import Web3

from shared.config import config

# ─── Constants ──────────────────────────────────────────────────────────────

#: EIP-712 domain name pinned in the deployed ``LimitOrderExecutor`` (eip712 §2).
EIP712_DOMAIN_NAME = "PitchTerminal LimitOrders"
#: EIP-712 domain version pinned in the deployed contract (eip712 §2).
EIP712_DOMAIN_VERSION = "1"
#: Base mainnet chain id; replay protection between chains relies on this.
BASE_CHAIN_ID = 8453

#: EIP-712 ``Order`` type fields — order is load-bearing (eip712 §3.1/§3.4).
ORDER_TYPE_FIELDS: list[dict[str, str]] = [
    {"name": "owner", "type": "address"},
    {"name": "token", "type": "address"},
    {"name": "quoteToken", "type": "address"},
    {"name": "venue", "type": "uint8"},
    {"name": "side", "type": "uint8"},
    {"name": "targetPrice", "type": "uint256"},
    {"name": "amountIn", "type": "uint256"},
    {"name": "slippageBps", "type": "uint256"},
    {"name": "expiry", "type": "uint256"},
    {"name": "nonce", "type": "uint256"},
]

#: Canonical type-string used by Solidity ``keccak256`` for ORDER_TYPEHASH.
ORDER_TYPE_STRING = (
    "Order(address owner,address token,address quoteToken,uint8 venue,"
    "uint8 side,uint256 targetPrice,uint256 amountIn,uint256 slippageBps,"
    "uint256 expiry,uint256 nonce)"
)

_ADDR_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
_NONCE_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")


# ─── Enums ──────────────────────────────────────────────────────────────────


class OrderStatus(StrEnum):
    """Lifecycle of a limit order (db-schema ``order_status``)."""

    PENDING = "pending"
    EXECUTING = "executing"
    FILLED = "filled"
    FAILED = "failed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class OrderSide(StrEnum):
    """Direction of the order (db-schema ``order_side``)."""

    LIMIT_BUY = "limit-buy"
    TAKE_PROFIT = "take-profit"


class OrderVenue(StrEnum):
    """Which pair the order trades on (db-schema ``order_venue``)."""

    PLAYER = "player"
    COUNTRY = "country"


def venue_to_int(venue: OrderVenue | str) -> int:
    """Map ``OrderVenue`` to the ``uint8`` value the contract signs (eip712 §3.3)."""

    s = str(venue)
    if s == OrderVenue.PLAYER.value:
        return 0
    if s == OrderVenue.COUNTRY.value:
        return 1
    raise ValueError(f"unknown venue: {venue!r}")


def side_to_int(side: OrderSide | str) -> int:
    """Map ``OrderSide`` to the ``uint8`` value the contract signs."""

    s = str(side)
    if s == OrderSide.LIMIT_BUY.value:
        return 0
    if s == OrderSide.TAKE_PROFIT.value:
        return 1
    raise ValueError(f"unknown side: {side!r}")


# ─── Pydantic models ────────────────────────────────────────────────────────


def _as_int(v: Any) -> int:
    """Coerce wei-strings/ints to ``int``; accept hex (``0x...``) too."""

    if isinstance(v, int):
        return v
    if isinstance(v, str):
        s = v.strip()
        if s.startswith(("0x", "0X")):
            return int(s, 16)
        return int(s)
    raise TypeError(f"cannot coerce {v!r} to int")


class OrderIn(BaseModel):
    """Validated payload for ``POST /api/v1/orders`` (api-spec §7.2).

    Mirrors EIP-712 ``Order`` 1:1 (camelCase). Numeric uint256 fields accept
    decimal strings or ints; the model normalizes them to ``int`` so the rest
    of the backend works with primitives, not strings.
    """

    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")

    owner: str
    token: str
    quoteToken: str
    venue: Literal[0, 1]
    side: Literal[0, 1]
    targetPrice: int
    amountIn: int
    slippageBps: int = Field(ge=0)
    expiry: int = Field(ge=0)
    nonce: str

    # ── Validators ──
    @field_validator("owner", "token", "quoteToken")
    @classmethod
    def _addr(cls, v: str) -> str:
        if not isinstance(v, str) or not _ADDR_RE.match(v):
            raise ValueError("not a 0x-prefixed 20-byte address")
        return v.lower()

    @field_validator("nonce")
    @classmethod
    def _nonce_hex(cls, v: str) -> str:
        if not isinstance(v, str) or not _NONCE_RE.match(v):
            raise ValueError("nonce must be a 32-byte 0x-prefixed hex string")
        return v.lower()

    @field_validator("targetPrice", "amountIn", mode="before")
    @classmethod
    def _coerce_wei(cls, v: Any) -> int:
        n = _as_int(v)
        if n <= 0:
            raise ValueError("must be > 0")
        return n


class OrderOut(BaseModel):
    """List/detail response shape (api-spec §7.1; camelCase, wei as strings)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    owner: str
    token: str
    quoteToken: str
    tokenSymbol: str | None
    tokenKind: str | None
    venue: str
    side: str
    targetPrice: str
    amountIn: str
    slippageBps: int
    expiresAt: int | None
    nonce: str
    status: str
    createdAt: int
    executedTxHash: str | None
    failReason: str | None
    failDetail: str | None


# ─── EIP-712 digest + signature verification ────────────────────────────────


def _typed_message(order: OrderIn, executor_address: str, chain_id: int) -> dict[str, Any]:
    """Build the ``full_message`` dict for :func:`encode_typed_data`."""

    return {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Order": ORDER_TYPE_FIELDS,
        },
        "primaryType": "Order",
        "domain": {
            "name": EIP712_DOMAIN_NAME,
            "version": EIP712_DOMAIN_VERSION,
            "chainId": chain_id,
            # eth_account expects a checksummed address here.
            "verifyingContract": to_checksum_address(executor_address),
        },
        "message": {
            "owner": to_checksum_address(order.owner),
            "token": to_checksum_address(order.token),
            "quoteToken": to_checksum_address(order.quoteToken),
            "venue": int(order.venue),
            "side": int(order.side),
            "targetPrice": int(order.targetPrice),
            "amountIn": int(order.amountIn),
            "slippageBps": int(order.slippageBps),
            "expiry": int(order.expiry),
            # nonce is a 32-byte hex string in the API; the contract treats the
            # corresponding uint256 — convert before signing.
            "nonce": int(order.nonce, 16),
        },
    }


def compute_order_digest(order: OrderIn, executor_address: str, chain_id: int) -> bytes:
    """Return the 32-byte EIP-712 digest that the user actually signs.

    Identical bytes to Solidity ``_digest(order)`` from docs/eip712.md §3.2.
    Used both for signature recovery and for the IC-2.1 cross-check ritual
    (docs/eip712.md §7) between viem and Solidity.
    """

    signable = encode_typed_data(full_message=_typed_message(order, executor_address, chain_id))
    # ``signable.body`` is the keccak256(struct), ``signable.header`` is the
    # domain separator. The final digest is keccak256(0x1901 || header || body).
    return bytes(Web3.keccak(b"\x19\x01" + bytes(signable.header) + bytes(signable.body)))


# ─── Signature verification ─────────────────────────────────────────────────


def _normalize_signature(signature: bytes | str) -> bytes:
    """Accept hex-string or bytes; return raw bytes."""

    if isinstance(signature, bytes):
        return signature
    if isinstance(signature, str):
        s = signature.strip()
        if not s.startswith(("0x", "0X")):
            s = "0x" + s
        return bytes(HexBytes(s))
    raise TypeError(f"signature must be bytes or hex-string, got {type(signature).__name__}")


def _recover_address(signable_hash: bytes, signature: bytes) -> str | None:
    """ECDSA-recover the signer of ``signable_hash``; return lowercase address or None."""

    try:
        from eth_keys.main import KeyAPI

        if len(signature) != 65:
            return None
        # Split r||s||v.
        r_bytes = signature[0:32]
        s_bytes = signature[32:64]
        v = signature[64]
        # Normalize v: wallets sign with {0,1} or {27,28}; eth_keys wants {0,1}.
        if v >= 27:
            v -= 27
        if v not in (0, 1):
            return None
        sig_obj = KeyAPI.Signature(
            vrs=(v, int.from_bytes(r_bytes, "big"), int.from_bytes(s_bytes, "big"))
        )
        pubkey = sig_obj.recover_public_key_from_msg_hash(signable_hash)
        addr = pubkey.to_checksum_address()
        return str(addr).lower()
    except Exception:
        return None


def verify_order_signature(
    order: OrderIn,
    signature: bytes | str,
    *,
    executor_address: str | None = None,
    chain_id: int = BASE_CHAIN_ID,
    allow_eip1271: bool = True,
) -> bool:
    """Return True if ``signature`` is a valid EIP-712 signature of ``order``.

    Verification path:

    1. Compute the EIP-712 digest.
    2. ECDSA-recover the signer; if it matches ``order.owner`` → True.
    3. (Optional, ``allow_eip1271=True``) Fallback to EIP-1271
       ``isValidSignature(bytes32 hash, bytes sig)`` — for smart-contract
       wallets. Requires a configured ``RPC_URL`` reachable; on RPC failure
       returns False (fail-closed for safety).

    ``executor_address`` defaults to :data:`shared.config.config.executor_contract`;
    callers can override for tests.
    """

    exec_addr = (executor_address or config.executor_contract or "").strip().lower()
    if not exec_addr or exec_addr == "0x" + "00" * 20:
        # Without a known executor address we cannot build a valid domain.
        # Tests must set EXECUTOR_CONTRACT or pass executor_address explicitly.
        return False

    raw_sig = _normalize_signature(signature)
    digest = compute_order_digest(order, exec_addr, chain_id)

    recovered = _recover_address(digest, raw_sig)
    if recovered is not None and recovered == order.owner.lower():
        return True

    if not allow_eip1271:
        return False

    # EIP-1271 fallback for smart-contract wallets.
    try:
        from shared.eth import get_w3

        w3 = get_w3()
        # isValidSignature(bytes32 _hash, bytes _signature) returns bytes4
        selector = Web3.keccak(text="isValidSignature(bytes32,bytes)")[:4]
        # Encode (bytes32, bytes) according to ABI:
        from eth_abi.abi import encode as abi_encode

        encoded = selector + abi_encode(["bytes32", "bytes"], [digest, raw_sig])
        result: HexBytes = w3.eth.call(
            {
                "to": to_checksum_address(order.owner),
                "data": HexStr("0x" + encoded.hex()),
            }
        )
        # Magic value: 0x1626ba7e
        return bytes(result)[:4] == b"\x16\x26\xba\x7e"
    except Exception:
        return False


# ─── Quote-token / pair validation ──────────────────────────────────────────


class QuoteTokenError(ValueError):
    """Raised when the signed ``quoteToken`` does not match the expected pair."""


def expected_quote_token(
    *,
    venue: OrderVenue | str,
    token_address: str,
    token_kind: str,
    country_address: str | None,
    pitch_token: str,
) -> str:
    """Return the canonical ``quoteToken`` for ``(venue, token)`` per eip712 §3.3.

    Raises :class:`QuoteTokenError` if the seed data is inconsistent
    (e.g. venue=player but token has no country_address).
    """

    s_venue = str(venue)
    if s_venue == OrderVenue.PLAYER.value:
        if token_kind != "player":
            raise QuoteTokenError("venue=player but token kind is not 'player'")
        if not country_address:
            raise QuoteTokenError("player token has no country_address in seed")
        return country_address.lower()
    if s_venue == OrderVenue.COUNTRY.value:
        if token_kind != "country":
            raise QuoteTokenError("venue=country but token kind is not 'country'")
        if not pitch_token:
            raise QuoteTokenError("PITCH_TOKEN env not configured")
        return pitch_token.lower()
    raise QuoteTokenError(f"unknown venue: {venue!r}")


def validate_quote_token(
    *,
    order: OrderIn,
    venue: OrderVenue,
    token_kind: str,
    country_address: str | None,
    pitch_token: str | None = None,
) -> None:
    """Raise :class:`QuoteTokenError` if ``order.quoteToken`` does not match.

    See docs/eip712.md §3.3 and docs/api-spec.md §7.2 server-check #5.
    """

    expected = expected_quote_token(
        venue=venue,
        token_address=order.token,
        token_kind=token_kind,
        country_address=country_address,
        pitch_token=(pitch_token or config.pitch_token),
    )
    if order.quoteToken.lower() != expected.lower():
        raise QuoteTokenError(f"quoteToken mismatch: expected {expected}, got {order.quoteToken}")


# ─── Misc helpers ───────────────────────────────────────────────────────────


def venue_from_int(v: int) -> OrderVenue:
    """Inverse of :func:`venue_to_int`."""

    if v == 0:
        return OrderVenue.PLAYER
    if v == 1:
        return OrderVenue.COUNTRY
    raise ValueError(f"unknown venue int: {v}")


def side_from_int(v: int) -> OrderSide:
    """Inverse of :func:`side_to_int`."""

    if v == 0:
        return OrderSide.LIMIT_BUY
    if v == 1:
        return OrderSide.TAKE_PROFIT
    raise ValueError(f"unknown side int: {v}")


def to_checksum(addr: str) -> ChecksumAddress:
    """Convenience: lowercase 0x-addr → checksum (for RPC params)."""

    return to_checksum_address(addr)


__all__ = [
    "BASE_CHAIN_ID",
    "EIP712_DOMAIN_NAME",
    "EIP712_DOMAIN_VERSION",
    "ORDER_TYPE_FIELDS",
    "ORDER_TYPE_STRING",
    "OrderIn",
    "OrderOut",
    "OrderSide",
    "OrderStatus",
    "OrderVenue",
    "QuoteTokenError",
    "compute_order_digest",
    "expected_quote_token",
    "side_from_int",
    "side_to_int",
    "to_checksum",
    "validate_quote_token",
    "venue_from_int",
    "venue_to_int",
    "verify_order_signature",
]
