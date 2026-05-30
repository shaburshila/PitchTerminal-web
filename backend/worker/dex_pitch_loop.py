"""External-PITCH DEX trade indexer (PITCH<->ETH/WETH/USDC swaps).

Mirrors :mod:`worker.event_loop` structure, but discovers candidate trade txs
from **DEX Swap events in the external PITCH pools** (NOT from PITCH ERC20
Transfer logs). This is a HYBRID: a cheap, topic-filtered Swap-event scan finds
candidate tx hashes; the existing receipt-based classifier then accurately
classifies them (handling multi-hop deliveries).

WHY NOT TRANSFER-SCAN (incident 2026-05-31): PITCH had a MASSIVE airdrop at
deploy (89,423 transfers in the first ~13k blocks). Scanning ALL PITCH Transfer
logs cold-started into tens of thousands of sequential receipt fetches, blocking
the worker (and the keeper / price loops that run after it) for minutes. The
Swap-event scan returns only actual external swaps (hundreds total) — the
89k-transfer airdrop noise and the in-app country pool never enter the picture.

Per tick:

1. Read ``app_state.dex_last_scanned_block`` (default ``DEX_SCAN_FROM_BLOCK``).
2. Compute ``head = block_number - REORG_LAG_BLOCKS``.
3. Process the range in chunks of ``chunk_blocks_default``. PER CHUNK:
   * :func:`_scan_swap_candidate_txs` — two topic-filtered ``eth_getLogs``:
     - Uniswap V3 PITCH/WETH pool: ``address=pool, topics=[V3_SWAP_TOPIC]``.
     - Uniswap V4 PoolManager: ``address=manager,
       topics=[V4_SWAP_TOPIC, V4_EXTERNAL_POOL_ID]`` (the indexed poolId in
       topic1 filters server-side to ONLY the external ETH/PITCH pool).
     Union of their tx hashes = the candidate external-trade txs.
   * :func:`_fetch_tx_legs` — one ``getTransactionReceipt`` per candidate tx
     reads its PITCH/WETH/USDC ``Transfer`` legs + ``tx.from``;
     ``getTransaction`` only for native-ETH suspects (``tx.value``).
   * :func:`shared.dex_pitch.classify_external_pitch_trades` — the pure,
     multi-hop-aware classifier yields buy/sell + pitch_amount + quote.
   * Batch-upsert into ``dex_pitch_trades`` (``ON CONFLICT DO NOTHING``).
   * ADVANCE the cursor to the chunk end (per-chunk checkpointing, like
     ``backfill.py``) — so a crash mid-tick re-scans only the in-flight chunk.
4. STOP starting new chunks once the wall-clock budget
   (``DEX_TICK_BUDGET_SEC``) is exceeded. The deadline is ALSO checked inside
   :func:`_fetch_tx_legs` before every receipt fetch, so a single chunk with a
   burst of candidates can't run unbounded either: the receipt loop yields at the
   deadline (cursor held, chunk re-scanned next tick). Combined with the 10s
   per-call RPC timeout, a tick can never block the worker for more than
   ~budget + one in-flight RPC call — regardless of candidate volume. This is the
   hard guarantee that the 2026-05-31 starvation incident cannot recur.

Cursor key is ``dex_last_scanned_block`` — fully independent from the hook
scanner's ``last_scanned_block`` so the two never interfere.

Block timestamps are resolved once per unique block (``dex_pitch_trades.ts`` is
NOT NULL); if any block timestamp can't be fetched the chunk aborts WITHOUT
advancing the cursor and the range is retried next tick (so ``ts`` is never a
wall-clock guess — it matters for money-weighted ROI ordering). Writes are
idempotent (``ON CONFLICT (tx_hash, log_index) DO NOTHING``).

The per-call RPC timeout already exists (``shared.eth.get_w3`` request_kwargs
timeout=10) so no single call hangs; the wall-clock budget bounds the aggregate.
``_MAX_BLOCKS_PER_TICK`` stays as a hard upper bound, but the time budget is the
real guard against a starving cold-start.
"""

from __future__ import annotations

import time
from datetime import UTC, datetime
from typing import Any

from web3 import Web3

from shared.config import (
    DEX_TICK_BUDGET_SEC,
    DEX_V3_POOL,
    DEX_V4_POOL_MANAGER,
    PITCH_TOKEN_ADDR,
    USDC_ADDR,
    V3_SWAP_TOPIC,
    V4_EXTERNAL_POOL_ID,
    V4_SWAP_TOPIC,
    WETH_ADDR,
    config,
)
from shared.db import get_conn
from shared.dex_pitch import (
    DexTrade,
    TransferLog,
    classify_external_pitch_trades,
    decode_transfer_log,
)
from shared.eth import lc
from shared.log import get_logger
from worker import _w3, operator_alerts, state

log = get_logger("worker.dex_pitch_loop")

CURSOR_KEY = "dex_last_scanned_block"

# Hard upper bound on blocks scanned per tick. The wall-clock budget
# (DEX_TICK_BUDGET_SEC) is the REAL cold-start guard — this is just a ceiling so
# a pathological run with near-zero candidate txs (so the budget never trips)
# still advances in bounded steps. Steady-state ticks scan only a handful of
# new blocks, so this only bites during backfill.
_MAX_BLOCKS_PER_TICK = 200_000

_PITCH = PITCH_TOKEN_ADDR.lower()
_WETH = WETH_ADDR.lower()
_USDC = USDC_ADDR.lower()


def _resolve_timestamps(w3: Any, blocks: set[int]) -> dict[int, int]:
    """Fetch ``block.timestamp`` (unix sec) for each unique block."""

    out: dict[int, int] = {}
    for b in blocks:
        try:
            blk = w3.eth.get_block(b)
            out[int(b)] = int(blk.timestamp)
        except Exception:
            log.exception("dex_pitch_loop.timestamp_fetch_failed", block=b)
            out[int(b)] = 0
    return out


def _scan_swap_candidate_txs(
    w3: Any,
    from_block: int,
    to_block: int,
    chunk_size: int,
) -> set[str]:
    """Return tx hashes of EXTERNAL PITCH swaps in ``[from_block, to_block]``.

    Two topic-filtered ``eth_getLogs`` per chunk over the external PITCH pools:

    * Uniswap V3 PITCH/WETH pool, ``topics=[V3_SWAP_TOPIC]``.
    * Uniswap V4 PoolManager, ``topics=[V4_SWAP_TOPIC, V4_EXTERNAL_POOL_ID]`` —
      the indexed poolId in topic1 filters server-side to ONLY the external
      ETH/PITCH pool, EXCLUDING the in-app country/PITCH pool and all airdrop
      noise.

    Returns the union of the two scans' tx hashes — the candidate external-trade
    txs. The receipt-based classifier then accurately classifies each (a
    multi-hop aggregator route, e.g. WETH->USDC->PITCH, is still discovered
    because it touches one of these pools, and is summed to the full PITCH
    delivery via the receipt legs).
    """

    if from_block > to_block:
        return set()

    v3_pool = Web3.to_checksum_address(DEX_V3_POOL)
    v4_manager = Web3.to_checksum_address(DEX_V4_POOL_MANAGER)

    candidates: set[str] = set()
    for start in range(from_block, to_block + 1, chunk_size):
        end = min(start + chunk_size - 1, to_block)
        v3_logs = w3.eth.get_logs(
            {
                "address": v3_pool,
                "fromBlock": start,
                "toBlock": end,
                "topics": [V3_SWAP_TOPIC],
            }
        )
        v4_logs = w3.eth.get_logs(
            {
                "address": v4_manager,
                "fromBlock": start,
                "toBlock": end,
                "topics": [V4_SWAP_TOPIC, V4_EXTERNAL_POOL_ID],
            }
        )
        for raw in (*v3_logs, *v4_logs):
            tx_hash = raw["transactionHash"] if isinstance(raw, dict) else raw.transactionHash
            candidates.add(_hexstr(tx_hash))
    return candidates


def _hexstr(value: Any) -> str:
    """Normalize a tx hash (bytes / HexBytes / str) to a lowercase 0x string."""

    if isinstance(value, bytes | bytearray):
        return "0x" + bytes(value).hex().lower()
    s = str(value).lower()
    return s if s.startswith("0x") else "0x" + s


def _fetch_tx_legs(
    w3: Any, tx_hashes: set[str], deadline: float = float("inf")
) -> tuple[list[TransferLog], dict[str, int], dict[str, str], bool]:
    """Read the full counter-legs of each candidate swap tx from its receipt.

    Returns ``(legs, values, froms, complete)``:
    * ``legs`` — all decoded PITCH/WETH/USDC ``Transfer`` legs across the
      processed candidate txs. Summing these correctly handles multi-leg /
      multi-hop deliveries (e.g. a WETH->USDC->PITCH route delivering PITCH in
      2 legs).
    * ``values`` — ``tx.value`` (native ETH wei), only for native-ETH suspects.
    * ``froms`` — ``tx.from`` (trader EOA), from the receipt's sender.
    * ``complete`` — ``False`` if the per-tick wall-clock ``deadline`` cut the
      receipt loop short (so the caller must NOT advance the cursor and re-scans
      the chunk next tick). This is the SAFETY bound: each ``getTransactionReceipt``
      is one RPC call (10s provider timeout), and we check the deadline BEFORE
      every receipt, so this loop can never block the worker for more than the
      deadline + one in-flight call — even on a pathological burst of candidates.

    One ``getTransactionReceipt`` per candidate tx (bounded to ACTUAL external
    swaps, NOT to PITCH transfer volume) and one ``getTransaction`` only per
    native-ETH suspect. ``tx.from`` pins both the trader and the buy/sell
    direction (pool-vs-trader is otherwise symmetric). Failures skip the tx /
    leave value 0.
    """

    legs: list[TransferLog] = []
    values: dict[str, int] = {}
    froms: dict[str, str] = {}
    suspects: list[str] = []
    complete = True

    for tx_hash in tx_hashes:
        if time.time() >= deadline:
            complete = False
            break
        try:
            rc = w3.eth.get_transaction_receipt(tx_hash)
        except Exception:
            log.exception("dex_pitch_loop.receipt_fetch_failed", tx_hash=tx_hash)
            continue
        rc_logs = rc["logs"] if isinstance(rc, dict) else rc.logs
        # AttributeDict (web3) and plain dict both support ``["from"]``;
        # ``.from`` is a Python keyword so attribute access is impossible.
        sender = rc["from"]
        if sender:
            froms[tx_hash] = lc(sender)
        tx_legs = [d for raw in rc_logs if (d := decode_transfer_log(raw)) is not None]
        legs.extend(tx_legs)
        if not any(t.token in (_WETH, _USDC) for t in tx_legs):
            suspects.append(tx_hash)

    for tx_hash in suspects:
        try:
            tx = w3.eth.get_transaction(tx_hash)
            values[tx_hash] = int(tx["value"] if isinstance(tx, dict) else tx.value)
        except Exception:
            log.exception("dex_pitch_loop.tx_value_fetch_failed", tx_hash=tx_hash)
            values.setdefault(tx_hash, 0)

    return legs, values, froms, complete


def _upsert_trades(trades: list[DexTrade], timestamps: dict[int, int]) -> int:
    """Batch-insert trades. Returns rows actually inserted (ignoring conflicts)."""

    if not trades:
        return 0

    rows = []
    for t in trades:
        ts_unix = timestamps.get(int(t.block_number), 0)
        ts_dt = datetime.fromtimestamp(ts_unix, tz=UTC) if ts_unix > 0 else datetime.now(tz=UTC)
        rows.append(
            (
                int(t.block_number),
                t.tx_hash,
                int(t.log_index),
                lc(t.trader_address),
                t.direction,
                int(t.pitch_amount),
                lc(t.quote_token),
                int(t.quote_amount),
                ts_dt,
            )
        )

    with get_conn() as conn, conn.cursor() as cur:
        cur.executemany(
            """
            INSERT INTO dex_pitch_trades
                (block_number, tx_hash, log_index, trader_address, direction,
                 pitch_amount, quote_token, quote_amount, ts)
            VALUES (%s, %s, %s, %s, %s::event_side, %s, %s, %s, %s)
            ON CONFLICT (tx_hash, log_index) DO NOTHING
            """,
            rows,
        )
        inserted = cur.rowcount if cur.rowcount is not None else 0
        conn.commit()
    return int(inserted)


def scan_range(w3: Any, from_block: int, to_block: int, chunk_size: int) -> list[DexTrade]:
    """Scan + classify external-PITCH trades in ``[from_block, to_block]``.

    Discovers candidate txs from the external-pool Swap events, reads their
    receipt legs + native-ETH values, then runs the pure classifier. Returned
    trades are NOT yet written. Exposed (and unit-friendly) so a one-off
    validation script can call it against real on-chain logs.
    """

    candidate_txs = _scan_swap_candidate_txs(w3, from_block, to_block, chunk_size)
    if not candidate_txs:
        return []

    # No deadline here — this is the full-scan validation/convenience API. The
    # worker tick path uses _process_chunk, which passes a real deadline.
    legs, tx_value, tx_from, _complete = _fetch_tx_legs(w3, candidate_txs)
    if not legs:
        return []

    return classify_external_pitch_trades(legs, tx_value=tx_value, tx_from=tx_from)


def _process_chunk(
    w3: Any, from_block: int, to_block: int, chunk_size: int, deadline: float
) -> str:
    """Scan + classify + upsert one chunk. Returns one of:

    * ``"ok"``      — chunk fully processed, cursor advanced to ``to_block``.
    * ``"ts_fail"`` — a block timestamp failed to resolve; cursor NOT advanced
      (re-scanned next tick — never persist a wall-clock-guess ``ts``).
    * ``"cut"``     — the per-tick ``deadline`` cut the receipt loop short before
      all candidates were processed; cursor NOT advanced (the chunk is re-scanned
      next tick; writes are idempotent so partial progress is never lost). This is
      what keeps a candidate burst from ever blocking the worker.
    """

    candidate_txs = _scan_swap_candidate_txs(w3, from_block, to_block, chunk_size)
    complete = True
    trades: list[DexTrade] = []
    if candidate_txs:
        legs, tx_value, tx_from, complete = _fetch_tx_legs(w3, candidate_txs, deadline)
        if legs:
            trades = classify_external_pitch_trades(legs, tx_value=tx_value, tx_from=tx_from)

    if trades:
        timestamps = _resolve_timestamps(w3, {int(t.block_number) for t in trades})
        if any(ts == 0 for ts in timestamps.values()):
            log.warning(
                "dex_pitch_loop.timestamp_incomplete_retry",
                from_block=from_block,
                to_block=to_block,
            )
            return "ts_fail"
        _upsert_trades(trades, timestamps)
        log.info(
            "dex_pitch_loop.chunk", from_block=from_block, to_block=to_block, trades=len(trades)
        )

    if not complete:
        log.info("dex_pitch_loop.receipt_budget_cut", from_block=from_block, to_block=to_block)
        return "cut"

    state.set_int_key(CURSOR_KEY, to_block)
    return "ok"


def tick() -> None:
    """One scan tick for external-PITCH DEX trades.

    Processes the pending range in chunks, checkpointing the cursor after each
    chunk, and STOPS starting new chunks once ``DEX_TICK_BUDGET_SEC`` is
    exceeded — so a slow cold-start can never starve the keeper / price loops.
    """

    try:
        w3 = _w3.get_w3()
        head_raw = int(w3.eth.block_number)
        head = head_raw - int(config.reorg_lag_blocks)

        default_from = int(config.dex_scan_from_block)
        if head < default_from:
            return

        last_scanned = state.get_int_key(CURSOR_KEY, default_from)
        from_block = last_scanned + 1
        if from_block > head:
            return

        # Hard ceiling on this tick's range (the time budget is the real guard).
        tick_end = min(head, from_block + _MAX_BLOCKS_PER_TICK - 1)
        chunk_size = int(config.chunk_blocks_default)

        deadline = time.time() + float(DEX_TICK_BUDGET_SEC)
        chunk_start = from_block
        while chunk_start <= tick_end:
            chunk_end = min(chunk_start + chunk_size - 1, tick_end)
            result = _process_chunk(w3, chunk_start, chunk_end, chunk_size, deadline)
            if result == "ts_fail":
                # Cursor NOT advanced. A persistent stall here would otherwise look
                # healthy, so surface it as a tick failure (transient blips recover).
                operator_alerts.record_tick_failure("dex_pitch_loop")
                return
            if result == "cut":
                # The deadline cut the receipt loop mid-chunk: cursor held, chunk
                # re-scanned next tick. A normal yield under load, not a failure.
                operator_alerts.record_tick_success("dex_pitch_loop")
                return
            # result == "ok": chunk fully processed, cursor advanced to chunk_end.
            chunk_start = chunk_end + 1
            # Stop STARTING new chunks once over budget. Combined with the
            # in-loop deadline of _fetch_tx_legs, a tick yields within
            # ~budget + one in-flight RPC call (10s) regardless of candidate volume.
            if time.time() >= deadline and chunk_start <= tick_end:
                log.info(
                    "dex_pitch_loop.tick_budget_yield",
                    next_block=chunk_start,
                    tick_end=tick_end,
                )
                break

        operator_alerts.record_tick_success("dex_pitch_loop")
    except Exception:
        log.exception("dex_pitch_loop.tick_failed")
        operator_alerts.record_tick_failure("dex_pitch_loop")


__all__ = ["CURSOR_KEY", "scan_range", "tick"]
