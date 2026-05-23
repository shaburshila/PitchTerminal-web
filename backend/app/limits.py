"""``flask-limiter`` configuration.

Per docs/api-spec.md §11:

* Default for "other GETs": ``600 / minute / IP``.
* Per-route lower limits are applied via the ``@limiter.limit(...)`` decorator
  at the route definition.

Storage backend is in-memory for MVP (single-process). When we move to a
multi-worker gunicorn setup, this will switch to Redis — see B0.9.

The limiter is created and bound to the Flask app inside :func:`init_limiter`,
which also exposes the module-level :data:`limiter` so route modules can
import it for per-route decorators.
"""

from __future__ import annotations

from flask import Flask
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

# Module-level singleton — populated by ``init_limiter`` at app-create time.
# Route modules import this to apply per-route limits via decorators.
limiter: Limiter = Limiter(
    key_func=get_remote_address,
    default_limits=["600 per minute"],
    storage_uri="memory://",
    strategy="fixed-window",
    headers_enabled=True,
)


def init_limiter(app: Flask) -> Limiter:
    """Attach the global :data:`limiter` to ``app`` and return it.

    Tests may opt out by setting ``app.config["RATELIMIT_ENABLED"] = False``
    via the ``LIMITS_ENABLED`` constructor arg of :func:`create_app`.
    """

    if not app.config.get("RATELIMIT_ENABLED", True):
        # flask-limiter still needs to be initialized to honor decorators,
        # but it won't enforce when disabled in config.
        app.config["RATELIMIT_ENABLED"] = False
    limiter.init_app(app)
    return limiter


__all__ = ["init_limiter", "limiter"]
