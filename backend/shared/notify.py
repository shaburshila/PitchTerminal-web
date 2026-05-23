"""Postgres LISTEN/NOTIFY helpers for the worker→API pub/sub bus.

Used by:

* **Producers** (worker tick loops): :func:`notify` sends ``pg_notify(channel,
  payload)`` via a short-lived pooled connection. Channels per
  ``docs/db-schema.sql`` and ``docs/api-spec.md`` §8.3:

  * ``pt_prices`` — JSON-array of lowercase token addresses whose price moved.
  * ``pt_events`` — JSON-array of new ``events.id`` BIGINTs.
  * ``pt_config`` — JSON snapshot of the access-config changes.
  * ``pt_orders`` — single ``limit_orders.id`` as text (phase 2 / premium).

* **Consumers** (SSE handlers in :mod:`app.routes.stream`): :class:`Listener`
  holds a dedicated ``psycopg.Connection`` in autocommit mode, registers
  ``LISTEN <channel>`` for each channel, and yields :class:`psycopg.Notify`
  objects via the streaming :meth:`Connection.notifies` API.

Why a *dedicated* connection (not from the pool):
* LISTEN state is per-session and survives across transactions. Pooled
  connections are returned to the pool and can be handed to another caller,
  losing the subscription. A dedicated connection is held for the lifetime of
  the SSE generator and closed on disconnect.

gevent compatibility:
* Under gevent, :mod:`psycogreen` patches ``psycopg`` so blocking socket reads
  yield to other green-threads. ``conn.notifies()`` is a generator that
  internally calls ``select`` — patched into ``gevent.select.select``, so the
  greenlet sleeps without blocking the loop.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import suppress
from types import TracebackType
from typing import Any

import psycopg

from shared.config import config
from shared.db import get_conn
from shared.log import get_logger

log = get_logger("shared.notify")

# Postgres caps NOTIFY payloads at NAMEDATALEN-ish; the documented limit is
# 8000 bytes after escaping. Producers MUST chunk arrays that risk overflow.
NOTIFY_PAYLOAD_MAX_BYTES = 7900


def notify(channel: str, payload: str) -> None:
    """Send ``pg_notify(channel, payload)`` via a short-lived pooled connection.

    Args:
        channel: Postgres notification channel name (e.g. ``"pt_prices"``).
            Must be a bare identifier — no quotes, no SQL injection vector.
        payload: UTF-8 text payload (typically JSON). Caller is responsible for
            keeping it under :data:`NOTIFY_PAYLOAD_MAX_BYTES` bytes.

    Raises:
        Does not raise — failures are logged and swallowed (the worker tick
        should not crash because pub/sub is degraded).
    """

    if len(payload.encode("utf-8")) > NOTIFY_PAYLOAD_MAX_BYTES:
        log.warning(
            "notify.payload_too_large",
            channel=channel,
            bytes=len(payload.encode("utf-8")),
        )
    try:
        with get_conn() as conn, conn.cursor() as cur:
            # ``pg_notify`` is the function form — supports parameterized
            # payload and channel name, no SQL escaping needed.
            # The pool context-manager commits on clean exit; no explicit
            # ``conn.commit()`` needed (review I, M2).
            cur.execute("SELECT pg_notify(%s, %s)", (channel, payload))
    except Exception:
        log.exception("notify.failed", channel=channel)


class Listener:
    """LISTEN-side of pg_notify. Holds a dedicated connection.

    Use as a context manager::

        with Listener(["pt_prices", "pt_events"]) as listener:
            for notif in listener.listen():
                ...

    The listener opens a fresh ``psycopg.Connection`` (not from the pool,
    since LISTEN is session-scoped), sets it to autocommit, and issues
    ``LISTEN`` for each channel. On exit it cleans up the connection.

    The :meth:`listen` method is a blocking generator — under gevent
    psycogreen-patched sockets cooperate with the event loop, so the greenlet
    sleeps efficiently.
    """

    def __init__(self, channels: list[str]) -> None:
        if not channels:
            raise ValueError("Listener requires at least one channel")
        # Validate identifiers — channel names go into SQL as bare identifiers.
        for ch in channels:
            if not ch.replace("_", "").isalnum():
                raise ValueError(f"invalid channel name: {ch!r}")
        self._channels = list(channels)
        self._conn: psycopg.Connection[Any] | None = None

    def __enter__(self) -> Listener:
        # Dedicated connection — autocommit so each LISTEN registers immediately.
        conn = psycopg.connect(config.database_url, autocommit=True)
        try:
            for ch in self._channels:
                # Channel names are validated in __init__ to be bare identifiers.
                conn.execute(f"LISTEN {ch}")
        except Exception:
            # Review I, M6: partial LISTEN must not leak the dedicated conn
            # if a later LISTEN raises — __exit__ won't fire because we never
            # finished __enter__. Close the conn explicitly and propagate.
            with suppress(Exception):
                conn.close()
            raise
        self._conn = conn
        log.debug("listener.opened", channels=self._channels)
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if self._conn is not None:
            with suppress(Exception):
                for ch in self._channels:
                    self._conn.execute(f"UNLISTEN {ch}")
            with suppress(Exception):
                self._conn.close()
            self._conn = None
            log.debug("listener.closed", channels=self._channels)

    def listen(self, timeout: float | None = None) -> Iterator[psycopg.Notify]:
        """Yield :class:`psycopg.Notify` objects as they arrive.

        Args:
            timeout: Optional per-iteration timeout in seconds. ``None`` means
                block forever (default). Under gevent the greenlet sleeps.

        Yields:
            ``psycopg.Notify`` with ``.channel``, ``.payload``, ``.pid``.
        """

        if self._conn is None:
            raise RuntimeError("Listener not entered (use `with Listener(...) as l:`)")
        # ``conn.notifies(timeout=...)`` is the psycopg 3.2 streaming generator.
        # It internally selects on the socket; under psycogreen this becomes a
        # cooperative wait.
        yield from self._conn.notifies(timeout=timeout)


__all__ = [
    "NOTIFY_PAYLOAD_MAX_BYTES",
    "Listener",
    "notify",
]
