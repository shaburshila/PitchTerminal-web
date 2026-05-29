"""Historical event backfill (B0.7).

One-shot historical scan of Buy/Sell events from both pitchwc hooks
(``PLAYER_HOOK`` + ``COUNTRY_HOOK``) starting at ``HOOK_DEPLOY_BLOCK`` up
to current head. Replaces the B0.6 stub which only pinned the live cursor.

The scan is **chunked** (``CHUNK_BLOCKS_DEFAULT`` blocks at a time) and
**resumable**: progress is persisted in ``app_state.backfill_status`` after
every successful chunk. On crash / RPC outage / operator restart the next
boot continues from ``progressBlock``.

State machine on ``app_state.backfill_status``:

* ``None`` (key missing)                       → run real backfill from
                                                  ``HOOK_DEPLOY_BLOCK``.
* ``{complete: true, stub: true, ...}``        → B0.6 stub left this; run
                                                  real backfill anyway to
                                                  fill the gap.
* ``{complete: true, ...}`` (without stub)     → skip; real backfill done.
* ``{complete: false, progressBlock: N, ...}`` → resume from N+1.

Important separation from the live ``event_loop`` cursor:

* ``app_state.last_scanned_block`` — cursor for **live ticks**; B0.6 stub
  pinned it forward to ``head - reorg_lag``. We do NOT read it as the
  backfill start.
* ``app_state.backfill_status.progressBlock`` — backfill's own cursor.

When the stub is being upgraded, the gap to fill is
``[HOOK_DEPLOY_BLOCK, last_scanned_block - 1]`` (since live ticks already
own everything ≥ ``last_scanned_block``). When there is no prior stub the
gap is ``[HOOK_DEPLOY_BLOCK, head - reorg_lag]``.

Retry policy: per-chunk RPC failures trigger exponential backoff
(1, 2, 4, 8, 16s, capped at 30s) for up to 5 attempts. On persistent
failure we abort and leave ``backfill_status`` as
``{complete: false, progressBlock: ...}`` so a subsequent restart resumes.

A second failure mode — "range too large" errors from the RPC — switches
the chunk size to ``CHUNK_BLOCKS_FALLBACK`` (default 2000) for the rest
of the run.

This function is **synchronous**: it blocks ``worker.main`` until done.
That can take minutes-to-hours on a fresh deploy; the DoD in
``docs/plans/backend.md`` §B0.7 explicitly tolerates that.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from shared import events as shared_events
from shared.config import HOOK_DEPLOY_BLOCK, config
from shared.db import get_conn
from shared.log import get_logger
from worker import _w3, state

log = get_logger("worker.backfill")

# Retry / backoff parameters.
_MAX_RETRIES = 5
_BACKOFF_BASE_SEC = 1.0
_BACKOFF_CAP_SEC = 30.0

# Keywords in RPC error messages that indicate the requested block range is
# too large — providers don't share a code, only a message. Matching is
# case-insensitive on the formatted error text.
_RANGE_TOO_LARGE_HINTS = (
    "range too large",
    "block range is too large",
    "too many results",
    "log response size exceeded",
    "query returned more than",
)


def _now_unix() -> int:
    return int(datetime.now(tz=UTC).timestamp())


def _is_range_too_large(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return any(h in msg for h in _RANGE_TOO_LARGE_HINTS)


def _sleep(seconds: float) -> None:
    """Tiny wrapper so tests can monkey-patch sleeping without freezing CI."""

    time.sleep(seconds)


def _resolve_timestamps(w3: Any, blocks: set[int]) -> dict[int, int]:
    """Fetch ``block.timestamp`` for each unique block (one RPC call each).

    H-2 fix (review H): on **any** block-timestamp fetch failure raise so
    the chunk is aborted and re-tried on the next run. Inserting historical
    events with ``datetime.now(UTC)`` (the old fallback) would silently
    skew change_pct / candles / trade-history because the ``ts`` column is
    used for time-based queries downstream. Better to abort and resume than
    pollute the dataset.

    A short retry-with-backoff loop is reasonable here (network hiccup) but
    keep it small — each chunk has up to N unique blocks and we don't want
    a single bad block to stall the whole backfill for minutes.
    """

    out: dict[int, int] = {}
    for b in blocks:
        last_exc: BaseException | None = None
        for attempt in range(3):
            try:
                blk = w3.eth.get_block(b)
                out[int(b)] = int(blk.timestamp)
                break
            except Exception as exc:
                last_exc = exc
                if attempt < 2:
                    _sleep(_BACKOFF_BASE_SEC * (2**attempt))
        else:
            log.error("backfill.timestamp_fetch_failed_after_retries", block=b)
            assert last_exc is not None
            raise RuntimeError(
                f"backfill: could not fetch block.timestamp for block {b}; "
                "aborting chunk to avoid polluting events.ts"
            ) from last_exc
    return out


def _insert_events(events: list[dict[str, Any]], timestamps: dict[int, int]) -> int:
    """Batch-insert decoded events. Returns rows actually inserted."""

    if not events:
        return 0

    rows = []
    for ev in events:
        ts_unix = timestamps.get(int(ev["block_number"]), 0)
        ts_dt = datetime.fromtimestamp(ts_unix, tz=UTC) if ts_unix > 0 else datetime.now(tz=UTC)
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

    with get_conn() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO events
                (block_number, tx_hash, log_index, token_address, side,
                 trader_address, base_value, token_value, fee, ts)
            VALUES (%s, %s, %s, %s, %s::event_side, %s, %s, %s, %s, %s)
            ON CONFLICT (tx_hash, log_index) DO NOTHING
            """,
            rows,
        )
        inserted = cur.rowcount if cur.rowcount is not None else 0
        conn.commit()
    return int(inserted)


def _scan_chunk_with_retry(
    w3: Any,
    hooks: list[str],
    chunk_start: int,
    chunk_end: int,
    chunk_size: int,
) -> tuple[list[dict[str, Any]], int, int]:
    """Scan one chunk with exponential backoff.

    Returns ``(events, new_chunk_size, actual_end)``:

    * ``events`` — decoded events for the scanned range.
    * ``new_chunk_size`` — may be smaller than the input ``chunk_size`` if
      the RPC complained the range was too large; the caller should adopt
      that size for subsequent chunks.
    * ``actual_end`` — the *real* upper bound that was scanned. Critical:
      when range-too-large triggers a shrink, this returns the SHRUNK end,
      not the originally requested one. The caller MUST advance
      ``progressBlock`` and the next iteration's ``chunk_start`` based on
      ``actual_end`` — otherwise the skipped blocks fall through a hole
      that no future re-run will reach (status reads ``complete=true``).

    Raises the last RPC exception if all retries fail.
    """

    attempt = 0
    current_chunk_size = chunk_size
    last_exc: BaseException | None = None
    while attempt < _MAX_RETRIES:
        try:
            events = list(
                shared_events.scan_logs(
                    w3,
                    hooks,
                    chunk_start,
                    chunk_end,
                    chunk_size=current_chunk_size,
                )
            )
            return events, current_chunk_size, chunk_end
        except Exception as exc:
            last_exc = exc
            if _is_range_too_large(exc) and current_chunk_size > config.chunk_blocks_fallback:
                # Don't burn a retry on this — switch chunk size and try again
                # immediately (the call was malformed, not the RPC busy).
                log.warning(
                    "backfill.chunk_too_large",
                    chunk_start=chunk_start,
                    chunk_end=chunk_end,
                    old_chunk_size=current_chunk_size,
                    new_chunk_size=config.chunk_blocks_fallback,
                )
                current_chunk_size = int(config.chunk_blocks_fallback)
                # Shrink the end of *this* chunk to the new size so we don't
                # immediately re-trigger the same error.
                chunk_end = min(chunk_end, chunk_start + current_chunk_size - 1)
                continue
            attempt += 1
            if attempt >= _MAX_RETRIES:
                break
            wait = min(_BACKOFF_BASE_SEC * (2 ** (attempt - 1)), _BACKOFF_CAP_SEC)
            log.warning(
                "backfill.chunk_retry",
                chunk_start=chunk_start,
                chunk_end=chunk_end,
                attempt=attempt,
                wait_sec=wait,
                error=str(exc),
            )
            _sleep(wait)

    assert last_exc is not None  # narrowing for mypy; loop guarantees this
    raise last_exc


def run_if_needed() -> None:
    """Backfill historical events if not already complete.

    Idempotent: subsequent calls (real complete state) are no-ops.
    Re-runs over a B0.6 stub state.
    Safe under empty hook env: logs a warning and marks complete.
    """

    try:
        status = state.get_json_key("backfill_status")
        if status is not None and status.get("complete") is True and not status.get("stub"):
            log.debug("backfill.skip", reason="already_complete")
            return

        # Empty hook env: nothing to scan. Mark complete so the worker loop
        # doesn't keep retrying — operator will set the envs and re-run.
        if not config.player_hook and not config.country_hook and not config.icon_hook:
            log.warning(
                "backfill.skip_empty_env",
                reason="PLAYER_HOOK, COUNTRY_HOOK and ICON_HOOK are all empty",
            )
            state.set_json_key(
                "backfill_status",
                {
                    "complete": True,
                    "stub": False,
                    "empty_env": True,
                    "events_inserted": 0,
                    "completed_at": _now_unix(),
                },
            )
            return

        hooks: list[str] = [
            h for h in (config.player_hook, config.country_hook, config.icon_hook) if h
        ]

        w3 = _w3.get_w3()
        head_raw = int(w3.eth.block_number)
        reorg_lag = int(config.reorg_lag_blocks)
        head = max(head_raw - reorg_lag, 0)

        # Decide range.
        # 1. Resume path: previous run aborted with progressBlock.
        # 2. Stub-upgrade path: B0.6 pinned last_scanned_block ahead of us; the
        #    live event_loop owns everything ≥ that block, so we backfill
        #    [HOOK_DEPLOY_BLOCK, last_scanned_block - 1]. We MUST NOT touch
        #    last_scanned_block here — live ticks own it.
        # 3. Cold start: full [HOOK_DEPLOY_BLOCK, head] range. On successful
        #    finish we pin last_scanned_block to to_block + 1 so the live
        #    event_loop doesn't re-scan the entire history from
        #    HOOK_DEPLOY_BLOCK on its first tick (review H, finding H-1).
        prev_inserted = 0
        is_cold_start = False
        if status is not None and status.get("complete") is False and "progressBlock" in status:
            from_block = int(status["progressBlock"]) + 1
            # Re-use to_block from the original run if present, otherwise head.
            to_block = int(status.get("to_block", head))
            prev_inserted = int(status.get("events_inserted", 0))
            log.info(
                "backfill.resume",
                from_block=from_block,
                to_block=to_block,
                already_inserted=prev_inserted,
            )
        elif status is not None and status.get("stub") is True:
            # Stub upgrade: respect the pinned live cursor.
            pinned = state.get_int_key("last_scanned_block", HOOK_DEPLOY_BLOCK)
            from_block = HOOK_DEPLOY_BLOCK
            to_block = max(pinned - 1, HOOK_DEPLOY_BLOCK - 1)
            log.info(
                "backfill.upgrade_from_stub",
                from_block=from_block,
                to_block=to_block,
                pinned_live_cursor=pinned,
            )
        else:
            from_block = HOOK_DEPLOY_BLOCK
            to_block = head
            is_cold_start = True
            log.info("backfill.cold_start", from_block=from_block, to_block=to_block)

        if from_block > to_block:
            # Nothing to do — e.g. stub pinned cursor to HOOK_DEPLOY_BLOCK
            # itself, or head is below deploy block (shouldn't happen on
            # mainnet but theoretically possible on a forked test RPC).
            log.info(
                "backfill.nothing_to_do",
                from_block=from_block,
                to_block=to_block,
            )
            state.set_json_key(
                "backfill_status",
                {
                    "complete": True,
                    "stub": False,
                    "from_block": from_block,
                    "to_block": to_block,
                    "events_inserted": prev_inserted,
                    "completed_at": _now_unix(),
                },
            )
            # H-1: cold-start with empty range still needs the cursor pinned.
            if is_cold_start:
                state.set_int_key("last_scanned_block", max(to_block, HOOK_DEPLOY_BLOCK) + 1)
            return

        log.info(
            "backfill.start",
            from_block=from_block,
            to_block=to_block,
            hooks=hooks,
        )

        chunk_size = int(config.chunk_blocks_default)
        cumulative_inserted = prev_inserted
        chunk_start = from_block
        while chunk_start <= to_block:
            chunk_end = min(chunk_start + chunk_size - 1, to_block)

            try:
                # C-1 fix (review H): `actual_end` is the *real* upper bound
                # the RPC saw. If `_scan_chunk_with_retry` downsized due to
                # "range too large", actual_end < the originally-requested
                # `chunk_end`. We MUST advance using actual_end — using the
                # old `chunk_end` would silently skip the blocks between
                # actual_end and chunk_end, and they'd be lost forever
                # (status: complete=true, no re-run ever sees them).
                events, chunk_size, actual_end = _scan_chunk_with_retry(
                    w3, hooks, chunk_start, chunk_end, chunk_size
                )
            except Exception:
                log.critical(
                    "backfill.abort_persistent_rpc_failure",
                    chunk_start=chunk_start,
                    chunk_end=chunk_end,
                )
                # Persist whatever progress we have so the next boot resumes.
                state.set_json_key(
                    "backfill_status",
                    {
                        "complete": False,
                        "from_block": from_block,
                        "to_block": to_block,
                        # progressBlock is the *last fully scanned* block;
                        # chunk_start - 1 is correct because chunk_start is
                        # the block we failed to scan.
                        "progressBlock": chunk_start - 1,
                        "events_inserted": cumulative_inserted,
                    },
                )
                return

            inserted = 0
            if events:
                unique_blocks = {int(ev["block_number"]) for ev in events}
                timestamps = _resolve_timestamps(w3, unique_blocks)
                inserted = _insert_events(events, timestamps)
                cumulative_inserted += inserted

            log.info(
                "backfill.chunk_done",
                chunk_start=chunk_start,
                chunk_end=actual_end,
                fetched=len(events),
                inserted=inserted,
                cumulative=cumulative_inserted,
            )

            state.set_json_key(
                "backfill_status",
                {
                    "complete": False,
                    "from_block": from_block,
                    "to_block": to_block,
                    "progressBlock": actual_end,
                    "events_inserted": cumulative_inserted,
                },
            )

            chunk_start = actual_end + 1

        state.set_json_key(
            "backfill_status",
            {
                "complete": True,
                "stub": False,
                "from_block": from_block,
                "to_block": to_block,
                "events_inserted": cumulative_inserted,
                "completed_at": _now_unix(),
            },
        )
        # H-1 fix (review H): on cold start, pin live event_loop cursor to
        # one past the highest block we scanned. Without this, event_loop's
        # default cursor stays at HOOK_DEPLOY_BLOCK and its first tick will
        # re-scan the entire history (millions of RPC calls; ON CONFLICT
        # protects data but wastes RPC quota and delays catch-up). Stub-
        # upgrade and resume paths already have a valid cursor — don't touch.
        if is_cold_start:
            state.set_int_key("last_scanned_block", to_block + 1)
        log.info(
            "backfill.complete",
            from_block=from_block,
            to_block=to_block,
            events_inserted=cumulative_inserted,
        )
    except Exception:
        log.exception("backfill.run_if_needed_failed")


__all__ = ["run_if_needed"]
