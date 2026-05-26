"""Flask app factory.

Wiring:
* Blueprints — ``health``, ``config``, ``tokens``, ``stream`` (FREE routes),
  ``auth`` (SIWE + JWT, B0.10); premium routes come in B0.11+.
* RFC 7807 error handlers (:mod:`app.errors`).
* ``flask-limiter`` (:mod:`app.limits`).
* structlog (:mod:`shared.log`).

App-level conventions:
* ``json.compact = True`` — smaller payloads (no extra whitespace).
* ``url_map.strict_slashes = False`` — ``/api/v1/tokens`` and ``/api/v1/tokens/``
  both resolve to the same handler (saves one redirect on every list call).
"""

from __future__ import annotations

import os
from typing import Any

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix

from app.errors import register_error_handlers
from app.limits import init_limiter
from app.routes import access as access_routes
from app.routes import auth as auth_routes
from app.routes import config as config_routes
from app.routes import health as health_routes
from app.routes import orders as orders_routes
from app.routes import portfolio as portfolio_routes
from app.routes import position as position_routes
from app.routes import profile as profile_routes
from app.routes import referral as referral_routes
from app.routes import stream as stream_routes
from app.routes import tokens as tokens_routes
from shared.db import init_pool
from shared.log import configure as configure_logger
from shared.sentry import init as init_sentry


def create_app(*, test_overrides: dict[str, Any] | None = None) -> Flask:
    """Construct a configured Flask app.

    Args:
        test_overrides: Optional config dict merged into ``app.config`` for
            tests (e.g. ``{"RATELIMIT_ENABLED": False}``).
    """

    configure_logger()
    # Sentry must be initialised before the Flask app is constructed so the
    # FlaskIntegration can hook request/response signals at app creation time.
    init_sentry("api")
    app = Flask(__name__)

    # ProxyFix: gunicorn sits behind Caddy in the Docker network, so
    # `request.remote_addr` defaults to the proxy container's internal IP.
    # Without this, flask-limiter buckets every client under one key and
    # per-IP limits on /auth/nonce, /auth/verify silently degrade to a shared
    # bucket. Trust exactly one proxy hop (our own Caddy) for X-Forwarded-*.
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[method-assign]

    # JSON config (compact + Unicode-safe).
    app.json.compact = True  # type: ignore[attr-defined]
    app.json.ensure_ascii = False  # type: ignore[attr-defined]

    # Both `/api/v1/tokens` and `/api/v1/tokens/` work.
    app.url_map.strict_slashes = False

    app.config["VERSION"] = os.environ.get("APP_VERSION", "dev")
    app.config["RATELIMIT_ENABLED"] = True
    if test_overrides:
        app.config.update(test_overrides)

    # Lazy DB-pool init — created on first use. Calling it here ensures the
    # connection pool exists before the first request and surfaces conninfo
    # errors at startup, not on the first /health.
    try:
        init_pool()
    except Exception:
        # Tests may run without DB; let /health surface the failure.
        app.logger.warning("DB pool init failed at startup — endpoints may degrade")

    # Limiter binds to the app (must be before route imports use decorators).
    init_limiter(app)

    register_error_handlers(app)

    app.register_blueprint(health_routes.bp)
    app.register_blueprint(config_routes.bp)
    app.register_blueprint(tokens_routes.bp)
    app.register_blueprint(stream_routes.bp)
    app.register_blueprint(auth_routes.bp)
    app.register_blueprint(referral_routes.bp)
    app.register_blueprint(profile_routes.bp)
    app.register_blueprint(position_routes.bp)
    app.register_blueprint(portfolio_routes.bp)
    app.register_blueprint(access_routes.bp)
    app.register_blueprint(orders_routes.bp)

    return app


__all__ = ["create_app"]
