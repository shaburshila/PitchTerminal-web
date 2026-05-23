"""Index ``PriceChanged`` + ``ReferralSplitUpdated`` from PitchTerminalAccess.

On every tick:
1. If ``ACCESS_CONTRACT`` env is empty → silent skip (normal until C0.5).
2. Pull logs for the contract in ``(last_scanned+1, head-reorg_lag)``.
3. Decode each via :func:`worker.access_decode.decode_access_log`; skip
   AccessPurchased / Granted / Revoked (they don't affect the snapshot).
4. Read the **current** price + discount + referral via one Multicall3 and
   UPSERT the snapshot into ``app_state.access_config``.
5. Idempotent: if the new ``txHash`` equals the stored one, do nothing.
6. ``pg_notify('pt_config', snapshot_json)`` so subscribed API processes
   refresh their ``/config`` cache (consumer side lands in B0.9).
7. Advance ``app_state.access_last_scanned_block``.
"""

from __future__ import annotations

import json
from typing import Any

from web3 import Web3

from shared.config import config
from shared.log import get_logger
from shared.notify import notify
from worker import _w3, state
from worker.access_bootstrap import _read_snapshot
from worker.access_decode import decode_access_log

log = get_logger("worker.access_event_loop")


def _fetch_logs(w3: Any, address: str, from_block: int, to_block: int) -> list[Any]:
    """Return all logs for ``address`` in the block range (no topic filter).

    We post-filter in :func:`access_decode.decode_access_log` since we want to
    pick up several distinct topic0 values from the same contract.
    """

    if from_block > to_block:
        return []
    checksum = Web3.to_checksum_address(address)
    raw: list[Any] = list(
        w3.eth.get_logs({"address": checksum, "fromBlock": from_block, "toBlock": to_block})
    )
    return raw


def _notify_snapshot(snapshot: dict[str, Any]) -> None:
    """``pg_notify('pt_config', ...)`` for SSE listeners (consumer in B0.9).

    Unified through :func:`shared.notify.notify` so payload-size capping and
    error logging stay in one place (review I, M4).
    """

    notify("pt_config", json.dumps(snapshot))


def tick() -> None:
    """One tick of the access-event indexer."""

    if not config.access_contract:
        log.debug("access_event_loop.skip", reason="ACCESS_CONTRACT not set")
        return

    try:
        w3 = _w3.get_w3()
        head = int(w3.eth.block_number) - int(config.reorg_lag_blocks)
        if head < 0:
            return

        # On the very first tick the cursor key may be missing — fall back to
        # access_deploy_block (env) or head (so we don't scan from 0).
        default_cursor = (
            int(config.access_deploy_block)
            if config.access_deploy_block > 0
            else head
        )
        last_scanned = state.get_int_key("access_last_scanned_block", default_cursor)
        from_block = last_scanned + 1
        if from_block > head:
            return

        logs = _fetch_logs(w3, config.access_contract, from_block, head)

        # Decode and keep only the events we care about.
        decoded = []
        for raw in logs:
            try:
                ev = decode_access_log(raw)
            except Exception:
                log.exception("access_event_loop.decode_failed")
                continue
            if ev is not None:
                decoded.append(ev)

        if decoded:
            # Re-read the live snapshot once — the latest on-chain values
            # supersede whatever the individual events carried (in case
            # several PriceChanged + ReferralSplitUpdated landed in the same
            # block range).
            latest = max(decoded, key=lambda e: (e["block_number"], e["log_index"]))
            existing = state.get_json_key("access_config") or {}
            if existing.get("txHash") == latest["tx_hash"]:
                log.debug("access_event_loop.skip", reason="same_txHash")
            else:
                price, discount, ref, _block = _read_snapshot()
                snapshot = {
                    "accessPriceWei": str(price),
                    "buyerDiscountBps": int(discount),
                    "referralBps": int(ref),
                    "blockNumber": int(latest["block_number"]),
                    "txHash": latest["tx_hash"],
                }
                state.set_json_key("access_config", snapshot)
                _notify_snapshot(snapshot)
                log.info(
                    "access_event_loop.snapshot",
                    accessPriceWei=snapshot["accessPriceWei"],
                    buyerDiscountBps=snapshot["buyerDiscountBps"],
                    referralBps=snapshot["referralBps"],
                    blockNumber=snapshot["blockNumber"],
                )

        # Always advance the cursor — even with 0 decoded events, we've
        # confirmed the range is empty so next tick should start past it.
        state.set_int_key("access_last_scanned_block", head)
    except Exception:
        log.exception("access_event_loop.tick_failed")


__all__ = ["tick"]
