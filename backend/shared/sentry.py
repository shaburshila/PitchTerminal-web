"""Sentry error tracking — shared init for Flask app and worker.

No-ops when ``SENTRY_DSN`` is unset, so dev and tests stay quiet. Only errors
are captured (``traces_sample_rate=0``) — APM/performance is intentionally
disabled to stay inside the free tier and avoid noise.

Sensitive values are scrubbed via a ``before_send`` hook that mirrors the
redaction patterns from :mod:`shared.log` (JWTs, private keys, signatures).
"""

from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from sentry_sdk._types import Event, Hint

_INITIALIZED = False

_SENSITIVE_KEY = re.compile(
    r"secret|token|signature|sig|cookie|password|private|authorization",
    re.IGNORECASE,
)
# Mirror shared.log patterns: long raw hex (≥ 64 chars, optional 0x prefix)
# and 3-part dot-separated base64url JWTs.
_HEX_BLOB = re.compile(r"^(0x)?[0-9a-fA-F]{64,}$")
_JWT_RE = re.compile(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$")


def _scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: ("<redacted>" if _SENSITIVE_KEY.search(k) else _scrub(v)) for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    if isinstance(value, str):
        if _JWT_RE.match(value):
            return "<redacted-jwt>"
        if _HEX_BLOB.match(value):
            return "<redacted-hex>"
    return value


def _before_send(event: Event, _hint: Hint) -> Event | None:
    return _scrub(event)  # type: ignore[no-any-return]


def init(component: str) -> bool:
    """Initialise Sentry once per process. Returns True if enabled.

    Args:
        component: Tag used as the ``server_name`` / component context
            (``"api"`` or ``"worker"``).
    """

    global _INITIALIZED
    if _INITIALIZED:
        return True

    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False

    import sentry_sdk

    integrations: list[Any] = []
    if component == "api":
        from sentry_sdk.integrations.flask import FlaskIntegration

        integrations.append(FlaskIntegration())

    sentry_sdk.init(
        dsn=dsn,
        release=os.environ.get("APP_VERSION", "dev"),
        environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
        traces_sample_rate=0.0,
        send_default_pii=False,
        include_local_variables=False,
        before_send=_before_send,
        integrations=integrations,
        server_name=component,
    )
    sentry_sdk.set_tag("component", component)
    _INITIALIZED = True
    return True


__all__ = ["init"]
