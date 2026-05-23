"""Referral-code handle validation + resolution.

Per docs/api-spec.md §5.2 + docs/plans/backend.md B0.11b:

* Format: ``^[a-z0-9_-]{4,32}$``, no leading/trailing ``-`` or ``_``.
* Reserved list — application-level (not in DB), denies common API/route slugs
  and a small profanity baseline. Changes ship via PR + redeploy.

The Postgres CHECK constraint on ``referral_codes.code`` mirrors the regex; the
reserved check is the only thing this module adds on top of the DB rules.
"""

from __future__ import annotations

import re

# Same source-of-truth as the DB CHECK constraint (see migration 0001 and
# docs/db-schema.sql `referral_codes`). Keep these in sync if either changes.
_CODE_RE = re.compile(r"^[a-z0-9_-]{4,32}$")

# Reserved handles — API/route slugs we don't want users to occupy, plus a
# small profanity baseline. Lowercase only (we lowercase input before checking).
RESERVED_CODES: frozenset[str] = frozenset(
    {
        # API / route slugs
        "api",
        "admin",
        "app",
        "auth",
        "config",
        "health",
        "me",
        "mine",
        "null",
        "ref",
        "static",
        "stream",
        "tokens",
        "undefined",
        "www",
        # Profanity (en/ru transliterations) — intentionally short list.
        "fuck",
        "shit",
        "cunt",
        "nazi",
        "hitl",
        "suka",
        "blya",
        "pidr",
    }
)


class InvalidFormat(ValueError):
    """``code`` does not match the regex or starts/ends with ``-``/``_``."""

    code = "referral.invalid_format"


class Reserved(ValueError):
    """``code`` is in the reserved-handles list."""

    code = "referral.reserved"


def validate_code(code: str) -> None:
    """Validate ``code`` against the spec rules. Raises on failure.

    Args:
        code: lowercase candidate handle.

    Raises:
        InvalidFormat: regex/leading/trailing violation.
        Reserved: code is in ``RESERVED_CODES``.
    """

    if not _CODE_RE.match(code):
        raise InvalidFormat("code must match ^[a-z0-9_-]{4,32}$")
    if code[0] in "-_" or code[-1] in "-_":
        raise InvalidFormat("code cannot start or end with '-' or '_'")
    if code in RESERVED_CODES:
        raise Reserved("code is reserved")


__all__ = ["RESERVED_CODES", "InvalidFormat", "Reserved", "validate_code"]
