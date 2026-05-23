"""Opaque cursor encoding for paginated endpoints.

Per docs/api-spec.md §1.5:

* Cursor is **base64url-encoded JSON** payload.
* For ``tokens/{token}/trades`` and ``profile.trades`` the payload is
  ``{"b": <block_number>, "l": <log_index>}`` and sorts descending.
* For ``orders`` (PREMIUM, not in this step) the payload is ``{"id": <id>}``.

These helpers are payload-agnostic — they just round-trip a dict through
base64url. The caller is responsible for the shape of the dict.
"""

from __future__ import annotations

import base64
import binascii
import json
from typing import Any

from app.errors import abort_with_problem


def encode_cursor(payload: dict[str, Any]) -> str:
    """Encode ``payload`` to a URL-safe opaque cursor string.

    The output is base64url **without padding** — RFC 4648 §5 — so it can be
    used as a query-string value without escaping.
    """

    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    encoded = base64.urlsafe_b64encode(raw).rstrip(b"=")
    return encoded.decode("ascii")


def decode_cursor(cursor: str) -> dict[str, Any]:
    """Decode a cursor produced by :func:`encode_cursor`.

    Bad cursors raise an RFC 7807 ``validation.bad_request`` error — we treat
    a corrupt cursor as a client bug, not a 500.
    """

    # Restore padding (urlsafe_b64decode is strict about it).
    pad_needed = -len(cursor) % 4
    padded = cursor + ("=" * pad_needed)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii"))
        payload = json.loads(raw.decode("utf-8"))
    except (binascii.Error, ValueError, UnicodeDecodeError) as exc:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad cursor",
            status=400,
            detail=f"cursor is not a valid base64url JSON: {exc}",
        )
        # Unreachable — abort_with_problem raises. Helps mypy.
        raise

    if not isinstance(payload, dict):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad cursor",
            status=400,
            detail="cursor payload must be a JSON object",
        )
    return payload  # type: ignore[no-any-return]


def clamp_limit(value: Any, *, default: int = 100, maximum: int = 500) -> int:
    """Parse & clamp the ``?limit=`` query param to ``[1, maximum]``.

    A missing param uses ``default``. Non-int / out-of-range values raise
    ``validation.bad_request`` — per api-spec §1.5 the contract is 1..500.
    """

    if value is None or value == "":
        return default
    try:
        n = int(value)
    except (TypeError, ValueError):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad limit",
            status=400,
            detail="limit must be an integer",
        )
        raise  # unreachable

    if n < 1 or n > maximum:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad limit",
            status=400,
            detail=f"limit must be in [1, {maximum}]",
        )
    return n


__all__ = ["clamp_limit", "decode_cursor", "encode_cursor"]
