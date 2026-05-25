"""B2.4 — expiry cycle for ``limit_orders``.

Once per ``EXPIRY_TICK_INTERVAL_SEC`` (30 s, called from
``worker.main``), :func:`tick` walks every open order whose
``expires_at`` has passed and marks it ``expired``. For each row it also
emits a ``NOTIFY pt_orders <id>`` so the SSE handler in
:mod:`app.routes.stream` pushes the status change to the connected client.

The SQL is intentionally tight (single UPDATE … RETURNING id) so the partial
index ``limit_orders_expiring_idx`` (see ``docs/db-schema.sql``) is used as
the scan path — the planner picks it because the WHERE clause matches the
index predicate exactly (``status='open' AND expires_at IS NOT NULL``).

Per ``docs/plans/backend.md`` B2.4 + ``docs/api-spec.md`` §7 (table of
status transitions: ``open → expired`` by API/worker).
"""

from __future__ import annotations

from typing import Any

from shared.db import get_conn
from shared.log import get_logger
from shared.notify import notify

log = get_logger("worker.expiry")

# Spec: 30s — see plans/backend.md B2.4.
EXPIRY_TICK_INTERVAL_SEC = 30


def tick(conn: Any | None = None) -> int:
    """Mark expired ``open`` orders and emit a ``pt_orders`` NOTIFY for each.

    Args:
        conn: Optional psycopg connection. When ``None`` (the production
            path), a pooled connection is checked out for the duration of
            the call. Tests pass an explicit connection so the UPDATE is
            visible to the assertion query without relying on transaction
            timing.

    Returns:
        Number of orders transitioned to ``expired`` in this tick.
    """

    sql = (
        "UPDATE limit_orders "
        "SET status = 'expired' "
        "WHERE status = 'open' "
        "  AND expires_at IS NOT NULL "
        "  AND expires_at <= now() "
        "RETURNING id"
    )

    if conn is None:
        with get_conn() as managed, managed.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
    else:
        with conn.cursor() as cur:
            cur.execute(sql)
            rows = cur.fetchall()
        # When the caller passed an explicit connection we don't commit
        # here — the caller decides transaction boundaries.

    expired_ids: list[int] = []
    for r in rows:
        # ``dict_row`` returns dicts; raw cursors return tuples. Handle both.
        if isinstance(r, dict):
            expired_ids.append(int(r["id"]))
        else:
            expired_ids.append(int(r[0]))

    if expired_ids:
        log.info("worker.expiry.tick", expired=len(expired_ids), ids=expired_ids[:20])
        for oid in expired_ids:
            # ``notify`` swallows its own errors — one failed pg_notify must
            # not abort the rest of the batch.
            notify("pt_orders", str(oid))

    return len(expired_ids)


__all__ = ["EXPIRY_TICK_INTERVAL_SEC", "tick"]
