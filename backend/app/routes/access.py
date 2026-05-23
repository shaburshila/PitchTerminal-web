"""``GET /api/v1/access`` — premium status for the authenticated wallet.

Per docs/api-spec.md §5.1 + docs/plans/backend.md B0.11.

* Always returns 200 to authed callers (auth itself fails 401). The body
  carries ``hasAccess`` + ``source`` so the front decides whether to
  prompt the pay-flow.
* Cached path (``GET /api/v1/access``): asymmetric TTL inside
  :mod:`shared.access` — true=1h, false=30s. Rate-limit 60/min/address.
* Fresh path (``GET /api/v1/access?fresh=1``): bypasses the cache, makes
  one RPC call per request. Rate-limit 5/min/address (api-spec §11).

Body shape (api-spec §5.1):
``{"address", "hasAccess", "source", "cachedAt", "checkedAt"}``.
"""

from __future__ import annotations

from typing import Any

from flask import Blueprint, g, jsonify, request
from flask_limiter.util import get_remote_address

from app.deps import require_auth
from app.limits import limiter
from shared.access import is_premium

bp = Blueprint("access", __name__)


def _addr_key() -> str:
    """Rate-limit key — wallet address (post-auth) with IP fallback.

    ``require_auth`` sets ``g.address`` *after* flask-limiter evaluates the
    key for some keying paths; the fallback to IP keeps the limit applied
    even in the (currently unreachable) case where it runs before auth.
    """

    return getattr(g, "address", None) or get_remote_address()


@bp.get("/api/v1/access")
@limiter.limit(
    "5 per minute",
    key_func=_addr_key,
    exempt_when=lambda: request.args.get("fresh") != "1",
)
@limiter.limit(
    "60 per minute",
    key_func=_addr_key,
    exempt_when=lambda: request.args.get("fresh") == "1",
)
@require_auth
def get_access() -> Any:
    """Return the caller's current access status.

    ``?fresh=1`` forces an RPC call and is rate-limited per address (5/min,
    api-spec §11). Cached path also keyed per address (60/min).
    """

    fresh = request.args.get("fresh") == "1"
    status = is_premium(g.address, fresh=fresh)
    return jsonify(
        {
            "address": g.address,
            "hasAccess": status.has_access,
            "source": status.source,
            "cachedAt": status.cached_at,
            "checkedAt": status.checked_at,
        }
    )


__all__ = ["bp"]
