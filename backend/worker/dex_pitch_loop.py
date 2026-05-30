"""External-PITCH DEX trade indexer (PITCH<->ETH/WETH/USDC swaps).

Mirrors :mod:`worker.event_loop` structure:

1. Read ``app_state.dex_last_scanned_block`` (default ``DEX_SCAN_FROM_BLOCK``).
2. Compute ``head = block_number - REORG_LAG_BLOCKS``.
3. Scan PITCH-ONLY ``Transfer`` logs over the range in chunks (1 topic-filtered
   ``eth_getLogs`` per chunk). WETH/USDC are deliberately NOT scanned directly —
   they are the highest-volume tokens on Base (millions of transfers) and would
   blow past ``eth_getLogs`` result limits. The PITCH legs only identify the
   candidate trade txs.
4. For each candidate (PITCH-touching) tx, read the full PITCH/WETH/USDC counter
   legs from its RECEIPT (:func:`_fetch_tx_legs`); fetch ``tx.value`` only for
   native-ETH suspects. Classify via the pure
   :func:`shared.dex_pitch.classify_external_pitch_trades`.
5. Batch-upsert into ``dex_pitch_trades`` with ``ON CONFLICT DO NOTHING``.
6. Advance ``app_state.dex_last_scanned_block`` to the (capped) ``to_block``.

Cursor key is ``dex_last_scanned_block`` — fully independent from the hook
scanner's ``last_scanned_block`` so the two never interfere.

Block timestamps are resolved once per unique block (``dex_pitch_trades.ts`` is
NOT NULL); if any block timestamp can't be fetched the tick aborts WITHOUT
advancing the cursor and retries the range next tick (so ``ts`` is never a
wall-clock guess — it matters for the money-weighted ROI ordering). Writes are
idempotent (``ON CONFLICT (tx_hash, log_index) DO NOTHING``), so a crash mid-tick
simply re-scans the in-flight range — no data loss.

COLD START: unlike the hook scanner, this loop fetches a RECEIPT per
PITCH-touching tx, so a one-shot full backfill could block the worker (and thus
the keeper/price loops that run after it) for minutes. Each tick therefore scans
at most ``_MAX_BLOCKS_PER_TICK`` blocks and advances the cursor to that capped
``to_block``; the backfill catches up GRADUALLY over successive ticks. Do not
remove the cap.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from web3 import Web3

from shared.config import (
    ERC20_TRANSFER_TOPIC,
    PITCH_TOKEN_ADDR,
    USDC_ADDR,
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

# Max blocks scanned per tick. Bounds the receipt-fetch work of a single tick so
# the cold-start backfill catches up GRADUALLY over many ticks instead of
# blocking the worker (keeper / price loops run after this one). Steady-state
# ticks scan only a handful of new blocks, so this only bites during backfill.
_MAX_BLOCKS_PER_TICK = 10_000

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


def _scan_transfers(
    w3: Any,
    from_block: int,
    to_block: int,
    chunk_size: int,
) -> Iterator[TransferLog]:
    """Yield decoded PITCH ``Transfer`` logs in ``[from_block, to_block]``.

    Scans ONLY the PITCH token (a niche, bounded-volume ERC20) — deliberately
    NOT WETH/USDC, which are the highest-volume tokens on Base (millions of
    transfers) and would blow past ``eth_getLogs`` result limits and RAM. These
    PITCH legs are used purely to find candidate trade txs; the WETH/USDC
    counter-legs are then read from each candidate tx's receipt (see
    :func:`_fetch_tx_legs`), which bounds RPC cost to PITCH-touching txs.
    """

    if from_block > to_block:
        return

    tokens = [Web3.to_checksum_address(_PITCH)]
    topics_filter = [ERC20_TRANSFER_TOPIC]

    for start in range(from_block, to_block + 1, chunk_size):
        end = min(start + chunk_size - 1, to_block)
        logs = w3.eth.get_logs(
            {
                "address": tokens,
                "fromBlock": start,
                "toBlock": end,
                "topics": topics_filter,
            }
        )
        for raw in logs:
            decoded = decode_transfer_log(raw)
            if decoded is not None:
                yield decoded


def _fetch_tx_legs(
    w3: Any, tx_hashes: set[str]
) -> tuple[list[TransferLog], dict[str, int], dict[str, str]]:
    """Read the full counter-legs of each candidate PITCH tx from its receipt.

    Returns ``(legs, values, froms)``:
    * ``legs`` — all decoded PITCH/WETH/USDC ``Transfer`` legs across the
      candidate txs (the WETH/USDC counter-legs the PITCH-only scan can't see).
    * ``values`` — ``tx.value`` (native ETH wei), fetched ONLY for native-ETH
      suspects (a candidate with a PITCH leg but no WETH/USDC leg).
    * ``froms`` — ``tx.from`` (trader EOA), taken from the receipt's sender.

    One ``getTransactionReceipt`` per candidate tx (bounded by PITCH-touching
    txs, NOT by WETH/USDC volume) and one ``getTransaction`` only per native-ETH
    suspect. ``tx.from`` pins both the trader and the buy/sell direction
    (pool-vs-trader is otherwise symmetric). Failures skip the tx / leave value
    0 (the trade then falls back to inference, or is dropped if ambiguous).
    """

    legs: list[TransferLog] = []
    values: dict[str, int] = {}
    froms: dict[str, str] = {}
    suspects: list[str] = []

    for tx_hash in tx_hashes:
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

    return legs, values, froms


def _candidate_trade_txs(transfers: list[TransferLog]) -> set[str]:
    """tx_hashes that move PITCH — the candidate external-trade txs.

    We fetch ``tx.from`` / ``tx.value`` for exactly these (one RPC each), which
    bounds the per-tick RPC cost to the number of PITCH-touching txs in the
    range rather than every Transfer.
    """

    return {t.tx_hash for t in transfers if t.token == _PITCH}


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

    Pure-ish orchestration over the RPC: collects Transfer logs, fetches
    ``tx.value`` only for native-ETH-buy candidates, then runs the pure
    classifier. Returned trades are NOT yet written. Exposed (and unit-friendly)
    so a one-off validation script can call it against real on-chain logs.
    """

    pitch_legs = list(_scan_transfers(w3, from_block, to_block, chunk_size))
    if not pitch_legs:
        return []

    candidate_txs = _candidate_trade_txs(pitch_legs)
    legs, tx_value, tx_from = _fetch_tx_legs(w3, candidate_txs)
    if not legs:
        return []

    return classify_external_pitch_trades(legs, tx_value=tx_value, tx_from=tx_from)


def tick() -> None:
    """One scan tick for external-PITCH DEX trades."""

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

        # Cap the window per tick. Unlike the hook scanner (which only decodes
        # logs), this loop fetches a RECEIPT per PITCH-touching tx — so a
        # cold-start that scanned the full ~500k-block history in one tick could
        # block the worker (and thus the keeper / price loops that run after it)
        # for minutes. Capping the per-tick range bounds each tick's receipt
        # count; the backfill then catches up gradually over successive ticks.
        to_block = min(head, from_block + _MAX_BLOCKS_PER_TICK - 1)

        chunk_size = int(config.chunk_blocks_default)
        trades = scan_range(w3, from_block, to_block, chunk_size)

        inserted = 0
        if trades:
            unique_blocks = {int(t.block_number) for t in trades}
            timestamps = _resolve_timestamps(w3, unique_blocks)
            # ``ts`` feeds the money-weighted ROI ordering, and writes are
            # ON CONFLICT DO NOTHING (a bad row never self-heals). If any block
            # timestamp failed to resolve, abort WITHOUT advancing the cursor so
            # the range is retried next tick — never persist a wall-clock guess.
            if any(ts == 0 for ts in timestamps.values()):
                log.warning(
                    "dex_pitch_loop.timestamp_incomplete_retry",
                    from_block=from_block,
                    to_block=to_block,
                )
                return
            inserted = _upsert_trades(trades, timestamps)
            log.info(
                "dex_pitch_loop.tick",
                from_block=from_block,
                to_block=to_block,
                trades=len(trades),
                inserted=inserted,
            )

        state.set_int_key(CURSOR_KEY, to_block)
        operator_alerts.record_tick_success("dex_pitch_loop")
    except Exception:
        log.exception("dex_pitch_loop.tick_failed")
        operator_alerts.record_tick_failure("dex_pitch_loop")


__all__ = ["CURSOR_KEY", "scan_range", "tick"]
