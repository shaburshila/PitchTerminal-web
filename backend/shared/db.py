"""Postgres connection pool + small helper API.

Uses ``psycopg`` (3.x) with ``psycopg_pool.ConnectionPool``. When running under
gevent (gunicorn workers patched by gevent), :func:`psycogreen.gevent.patch_psycopg`
must be invoked **before** ``psycopg`` is imported in any worker green-thread.
We detect "gevent mode" via ``sys.modules`` (gevent imports gevent in its bootstrap)
or the explicit ``_USE_GEVENT=1`` env var, and apply the patch at the top of
this module.

Public surface:
* :func:`init_pool` — idempotent, call once at startup.
* :func:`get_conn` — context manager yielding a pooled ``psycopg.Connection``.
* :func:`fetch_one`, :func:`fetch_all`, :func:`execute` — tiny query helpers
  using ``dict_row`` for row factory.
"""

from __future__ import annotations

import os
import sys

# IMPORTANT: gevent monkey-patch BEFORE importing psycopg. Detection:
# - module-level 'gevent' is already imported (gunicorn-gevent does this), OR
# - explicit env var _USE_GEVENT=1 (for tests / opt-in).
_GEVENT_ACTIVE = "gevent" in sys.modules or os.environ.get("_USE_GEVENT") in {"1", "true", "True"}
if _GEVENT_ACTIVE:  # pragma: no cover - hard to test without spinning up gevent
    try:
        from psycogreen.gevent import patch_psycopg  # type: ignore[import-untyped]

        patch_psycopg()
    except ImportError:
        # psycogreen optional in non-gevent contexts; if missing under gevent
        # the worker won't start cleanly, but that's a deploy issue not a
        # module-import bug. Don't crash import here.
        pass

import threading  # noqa: E402
from collections.abc import Iterator  # noqa: E402
from contextlib import contextmanager  # noqa: E402
from typing import Any  # noqa: E402

import psycopg  # noqa: E402
from psycopg.rows import dict_row  # noqa: E402
from psycopg_pool import ConnectionPool  # noqa: E402

from shared.config import config  # noqa: E402

_pool: ConnectionPool | None = None
_pool_lock = threading.Lock()


def init_pool(min_size: int = 1, max_size: int = 10) -> ConnectionPool:
    """Initialize the connection pool (idempotent).

    Safe to call multiple times — subsequent calls return the existing pool.
    """

    global _pool
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is None:
            _pool = ConnectionPool(
                conninfo=config.database_url,
                min_size=min_size,
                max_size=max_size,
                kwargs={"row_factory": dict_row},
                open=True,
            )
    return _pool


def _get_pool() -> ConnectionPool:
    if _pool is None:
        return init_pool()
    return _pool


@contextmanager
def get_conn() -> Iterator[psycopg.Connection[Any]]:
    """Context manager that checks out a connection from the pool.

    Usage::

        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
    """

    pool = _get_pool()
    with pool.connection() as conn:
        yield conn


def fetch_one(sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    """Execute ``sql`` and return the first row as a dict, or ``None``."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
        if row is None:
            return None
        # dict_row row factory already returns dicts.
        return dict(row)


def fetch_all(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    """Execute ``sql`` and return all rows as a list of dicts."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
        return [dict(r) for r in rows]


def execute(sql: str, params: tuple[Any, ...] = ()) -> int:
    """Execute ``sql`` (INSERT/UPDATE/DELETE), return affected ``rowcount``."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.rowcount


__all__ = [
    "execute",
    "fetch_all",
    "fetch_one",
    "get_conn",
    "init_pool",
]
