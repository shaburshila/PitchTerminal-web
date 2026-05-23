"""Hook event indexer (Buy/Sell from Player + Country hooks).

Each tick:
1. Read ``app_state.last_scanned_block`` (default = ``HOOK_DEPLOY_BLOCK``).
2. Compute ``head = w3.eth.block_number - REORG_LAG_BLOCKS``.
3. Scan hook logs via :func:`shared.events.scan_logs`, which streams decoded
   Buy/Sell events (see :mod:`shared.events`).
4. INSERT events with ``ON CONFLICT (tx_hash, log_index) DO NOTHING`` — so a
   repeated run over the same range is a no-op.
5. Advance ``app_state.last_scanned_block``.

Block timestamps: we resolve them once per unique block to keep
``events.ts`` non-NULL (the column has ``NOT NULL`` per ``db-schema.sql``).
A small dict cache avoids re-fetching the same block twice within a tick.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import psycopg

from shared.config import HOOK_DEPLOY_BLOCK, config
from shared.db import get_conn
from shared.events import scan_logs
from shared.log import get_logger
from shared.notify import notify
from worker import _w3, state

log = get_logger("worker.event_loop")


def _resolve_timestamps(w3: Any, blocks: set[int]) -> dict[int, int]:
    """Fetch ``block.timestamp`` (unix sec) for each unique block."""

    out: dict[int, int] = {}
    for b in blocks:
        try:
            blk = w3.eth.get_block(b)
            out[int(b)] = int(blk.timestamp)
        except Exception:
            # Fail-open: 0 sentinel (events.ts is NOT NULL — caller must
            # supply *something*; 0 means "unknown" per shared/types.Event).
            log.exception("event_loop.timestamp_fetch_failed", block=b)
            out[int(b)] = 0
    return out


def _insert_events(
    events: list[dict[str, Any]], timestamps: dict[int, int]
) -> tuple[int, list[int]]:
    """Batch-insert events.

    Returns ``(inserted_count, new_ids)`` where ``new_ids`` is the list of
    ``events.id`` BIGINTs of the rows actually inserted (ignoring conflicts).
    Used by the SSE pipeline to notify subscribers via ``pt_events``.
    """

    if not events:
        return 0, []

    rows = []
    for ev in events:
        ts_unix = timestamps.get(int(ev["block_number"]), 0)
        ts_dt = (
            datetime.fromtimestamp(ts_unix, tz=UTC) if ts_unix > 0 else datetime.now(tz=UTC)
        )
        rows.append(
            (
                int(ev["block_number"]),
                ev["tx_hash"],
                int(ev["log_index"]),
                ev["token_address"],
                ev["side"],
                ev["trader_address"],
                int(ev["base_value"]),
                int(ev["token_value"]),
                int(ev["fee"]),
                ts_dt,
            )
        )

    inserted = 0
    new_ids: list[int] = []
    with get_conn() as conn, conn.cursor() as cur:
        # ``executemany(..., returning=True)`` keeps one result set per row
        # in psycopg 3. Skipped rows (ON CONFLICT DO NOTHING) yield empty
        # result sets — we iterate via ``cur.nextset()`` to collect new ids.
        cur.executemany(
            """
            INSERT INTO events
                (block_number, tx_hash, log_index, token_address, side,
                 trader_address, base_value, token_value, fee, ts)
            VALUES (%s, %s, %s, %s, %s::event_side, %s, %s, %s, %s, %s)
            ON CONFLICT (tx_hash, log_index) DO NOTHING
            RETURNING id
            """,
            rows,
            returning=True,
        )
        # Iterate the per-row result sets. The first set is already current
        # after executemany returns; nextset() advances. Skipped rows (ON
        # CONFLICT DO NOTHING) yield empty result sets — fetchone() returns
        # None and we just move on without raising.
        while True:
            try:
                row = cur.fetchone()
            except psycopg.ProgrammingError:
                # Defensive: some psycopg builds raise "the last operation
                # didn't produce a result" on a skipped INSERT — swallow and
                # keep iterating.
                row = None
            if row is not None:
                inserted += 1
                new_ids.append(int(row["id"]))
            if not cur.nextset():
                break
        conn.commit()
    return inserted, new_ids


def tick() -> None:
    """One scan tick."""

    if not config.player_hook and not config.country_hook:
        # Neither hook configured — nothing to scan. Without these envs we
        # also can't initialize a sensible cursor, so just log once.
        log.debug("event_loop.skip", reason="no PLAYER_HOOK / COUNTRY_HOOK env")
        return

    try:
        w3 = _w3.get_w3()
        head_raw = int(w3.eth.block_number)
        head = head_raw - int(config.reorg_lag_blocks)
        if head < HOOK_DEPLOY_BLOCK:
            return

        last_scanned = state.get_int_key("last_scanned_block", HOOK_DEPLOY_BLOCK)
        from_block = last_scanned + 1
        if from_block > head:
            return

        hooks: list[str] = [h for h in (config.player_hook, config.country_hook) if h]

        events = list(
            scan_logs(
                w3,
                hooks,
                from_block,
                head,
                chunk_size=int(config.chunk_blocks_default),
            )
        )

        if events:
            unique_blocks = {int(ev["block_number"]) for ev in events}
            timestamps = _resolve_timestamps(w3, unique_blocks)
            inserted, new_ids = _insert_events(events, timestamps)

            # NOTIFY for the SSE pipeline (pt_events). Chunk by 500 ids to
            # stay under the ~8KB pg_notify payload limit (8 bytes/id-as-text
            # + 1 comma ≈ 4.5KB at 500).
            if new_ids:
                CHUNK = 500
                for i in range(0, len(new_ids), CHUNK):
                    notify("pt_events", json.dumps(new_ids[i : i + CHUNK]))

            log.info(
                "event_loop.tick",
                from_block=from_block,
                to_block=head,
                fetched=len(events),
                inserted=inserted,
            )

        state.set_int_key("last_scanned_block", head)
    except Exception:
        log.exception("event_loop.tick_failed")


__all__ = ["tick"]
