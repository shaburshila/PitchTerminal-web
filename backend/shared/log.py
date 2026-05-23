"""structlog configuration with redaction processor.

Per ``docs/conventions.md`` §8:
* JSON output to stdout, one object per line.
* Standard fields: ``time``, ``level``, ``event``, ``component``.
* Sensitive values redacted by name (``secret|token|signature|sig|cookie|password|private``)
  and by shape (JWT three-part dot-separated base64 → ``jwt:<sha256[:8]>``;
  long raw hex / bytes → ``<redacted>``).

Public surface:
* :func:`configure` — idempotent global setup (called from module import).
* :func:`get_logger` — bound logger with a ``component`` context field.
* :data:`REDACT_KEY_PATTERNS` — exposed for tests / introspection.
"""

from __future__ import annotations

import hashlib
import logging
import re
import sys
from typing import Any

import structlog
from structlog.types import EventDict, Processor, WrappedLogger

from shared.config import config

REDACT_KEY_PATTERNS = re.compile(
    r"secret|token|signature|sig|cookie|password|private", re.IGNORECASE
)

# Match a 3-part dot-separated base64url JWT.
_JWT_RE = re.compile(r"^[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+$")
# Long raw hex string (>= 64 chars after optional 0x) — likely a signature / key.
_LONG_HEX_RE = re.compile(r"^(0x)?[0-9a-fA-F]{64,}$")

_REDACTED = "<redacted>"


def _jwt_marker(token: str) -> str:
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:8]
    return f"jwt:{digest}"


def _redact_scalar(value: Any) -> Any:
    """Redact a value if it looks sensitive by *shape* (regardless of key)."""

    if isinstance(value, bytes):
        # Raw bytes long enough to be a signature/key → hide.
        if len(value) >= 32:
            return _REDACTED
        return value
    if isinstance(value, str):
        if _JWT_RE.match(value):
            return _jwt_marker(value)
        if _LONG_HEX_RE.match(value):
            return _REDACTED
    return value


def _redact_value(value: Any, key_is_sensitive: bool) -> Any:
    """Redact ``value`` recursively. If ``key_is_sensitive`` is True, *force*
    redaction of scalar values; otherwise only redact by shape."""

    if isinstance(value, dict):
        return {k: _redact_value(v, _key_sensitive(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v, key_is_sensitive) for v in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(v, key_is_sensitive) for v in value)
    if key_is_sensitive:
        # Sensitive key: still try to produce a useful marker for JWTs.
        if isinstance(value, str) and _JWT_RE.match(value):
            return _jwt_marker(value)
        return _REDACTED
    return _redact_scalar(value)


def _key_sensitive(key: Any) -> bool:
    return isinstance(key, str) and bool(REDACT_KEY_PATTERNS.search(key))


def redact_processor(_logger: WrappedLogger, _method_name: str, event_dict: EventDict) -> EventDict:
    """structlog processor: walks the event-dict and redacts sensitive values."""

    out: EventDict = {}
    for k, v in event_dict.items():
        out[k] = _redact_value(v, _key_sensitive(k))
    return out


_configured = False


def configure() -> None:
    """Configure structlog + stdlib logging. Idempotent."""

    global _configured
    if _configured:
        return

    level = getattr(logging, config.log_level.upper(), logging.INFO)
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=level,
    )

    processors: list[Processor] = [
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True, key="time"),
        redact_processor,
        structlog.processors.format_exc_info,
        structlog.processors.JSONRenderer(),
    ]
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.make_filtering_bound_logger(level),
        logger_factory=structlog.PrintLoggerFactory(file=sys.stdout),
        cache_logger_on_first_use=True,
    )
    _configured = True


def get_logger(component: str) -> Any:
    """Return a logger bound with ``component`` context (api|worker|keeper|…).

    Return type is ``Any`` to dodge structlog's heavy generic typing — the actual
    object is a ``structlog.BoundLogger`` proxy that supports the usual
    ``info/warn/error/debug`` methods.
    """

    configure()
    return structlog.get_logger().bind(component=component)


# Configure on import so any early ``get_logger`` call works without ceremony.
configure()


__all__ = [
    "REDACT_KEY_PATTERNS",
    "configure",
    "get_logger",
    "redact_processor",
]
