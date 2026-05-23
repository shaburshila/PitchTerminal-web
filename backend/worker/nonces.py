"""Periodic cleanup of stale SIWE nonces.

SIWE nonces are short-lived (~5 min). We retain double that (10 min) before
deleting so a slow client signing in still finds its nonce. Runs each tick
in :mod:`worker.main`; the underlying SQL is a trivial DELETE that the
``auth_nonces_created_idx`` makes ~O(log n).
"""

from __future__ import annotations

from shared.db import get_conn
from shared.log import get_logger

log = get_logger("worker.nonces")


def cleanup() -> None:
    """Delete ``auth_nonces`` rows older than 10 minutes."""

    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM auth_nonces WHERE created_at < now() - interval '10 minutes'"
            )
            deleted = cur.rowcount
            conn.commit()
        if deleted:
            log.info("nonces.cleanup", deleted=deleted)
    except Exception:
        log.exception("nonces.cleanup_failed")


__all__ = ["cleanup"]
