"""HS256 JWT encode/decode for session cookies.

Per docs/api-spec.md §2.2:

* Algorithm: HS256, shared secret from ``config.jwt_secret``.
* Claims: ``{iss, aud, sub, iat, exp}``.
  - ``iss = "pitchterminal-api"``
  - ``aud = "pitchterminal-web"``
  - ``sub = <lowercase address with 0x prefix>``
  - ``iat = issued-at unix sec``
  - ``exp = iat + ttl_seconds`` (default 72h)

Failures map to api-spec §1.4 error codes:

* expired → :class:`JwtExpired` (``auth.jwt.expired``)
* anything else (bad sig, malformed, wrong iss/aud) → :class:`JwtInvalid`
  (``auth.unauthenticated``)

We catch the broad set of pyjwt exceptions and re-raise our own typed
classes so route handlers don't need to depend on pyjwt internals.
"""

from __future__ import annotations

import time
from typing import Any

import jwt as _pyjwt

from shared.config import config

_ALGO = "HS256"
_ISS = "pitchterminal-api"
_AUD = "pitchterminal-web"
_DEFAULT_TTL_SEC = 72 * 3600


class JwtError(Exception):
    """Base for JWT errors. Subclasses carry a stable ``code`` per api-spec §1.4."""

    code: str = "auth.unauthenticated"


class JwtExpired(JwtError):
    code = "auth.jwt.expired"


class JwtInvalid(JwtError):
    code = "auth.unauthenticated"


def encode(address: str, *, ttl_seconds: int = _DEFAULT_TTL_SEC) -> str:
    """Encode an HS256 JWT for ``address`` (normalized lowercase).

    Args:
        address: Wallet address; will be lowercased before being stored in ``sub``.
        ttl_seconds: Token lifetime in seconds. Default 72h per api-spec §2.2.

    Returns:
        Compact JWT string (URL-safe base64).
    """

    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": _ISS,
        "aud": _AUD,
        "sub": address.lower(),
        "iat": now,
        "exp": now + int(ttl_seconds),
    }
    return _pyjwt.encode(claims, config.jwt_secret, algorithm=_ALGO)


def decode(token: str) -> str:
    """Decode and verify a JWT; return the lowercase address (``sub`` claim).

    Raises:
        JwtExpired: token is past its ``exp``.
        JwtInvalid: signature mismatch / malformed / wrong iss/aud /
            missing ``sub``.
    """

    try:
        claims = _pyjwt.decode(
            token,
            config.jwt_secret,
            algorithms=[_ALGO],
            audience=_AUD,
            issuer=_ISS,
            options={"require": ["exp", "iat", "sub", "iss", "aud"]},
        )
    except _pyjwt.ExpiredSignatureError as exc:
        raise JwtExpired("JWT expired") from exc
    except _pyjwt.InvalidTokenError as exc:
        # Covers DecodeError, InvalidSignatureError, InvalidIssuerError,
        # InvalidAudienceError, MissingRequiredClaimError, etc.
        raise JwtInvalid(f"JWT invalid: {exc.__class__.__name__}") from exc

    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub.startswith("0x") or len(sub) != 42:
        raise JwtInvalid("JWT 'sub' missing or malformed")
    return sub.lower()


__all__ = [
    "JwtError",
    "JwtExpired",
    "JwtInvalid",
    "decode",
    "encode",
]
