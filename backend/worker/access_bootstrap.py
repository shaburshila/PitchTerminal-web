"""One-shot bootstrap of ``app_state.access_config`` and its scan cursor.

On the very first worker boot the access contract is already deployed (or it
isn't yet — Phase 0 lets ``ACCESS_CONTRACT`` env stay empty until C0.5
finishes). When it IS configured, we want ``GET /api/v1/config`` to return
real values without waiting for an event — so we read the three current
fields directly and write a snapshot with ``txHash=null``.

Idempotent: if ``app_state.access_config`` already exists, do nothing.
"""

from __future__ import annotations

from web3 import Web3

from shared.config import config
from shared.eth import multicall3_aggregate
from shared.log import get_logger
from worker import _w3, state

log = get_logger("worker.access_bootstrap")

# 4-byte selectors for the three view functions we need from
# PitchTerminalAccess. Computed once at module import. We hardcode them
# instead of pulling the ABI from disk because (a) the ABI file isn't
# generated until after C0.4, and (b) these signatures are part of the
# contract API and won't change without a redeploy + env-var swap anyway.
_PRICE_SEL = Web3.keccak(text="price()")[:4]
_DISCOUNT_SEL = Web3.keccak(text="buyerDiscountBps()")[:4]
_REFERRAL_SEL = Web3.keccak(text="referralBps()")[:4]


def _read_snapshot() -> tuple[int, int, int, int]:
    """Return ``(price, buyer_discount_bps, referral_bps, block_number)``.

    Uses one Multicall3 batch — see :func:`shared.eth.multicall3_aggregate`.
    """

    w3 = _w3.get_w3()
    addr = config.access_contract
    calls: list[tuple[str, bytes]] = [
        (addr, _PRICE_SEL),
        (addr, _DISCOUNT_SEL),
        (addr, _REFERRAL_SEL),
    ]
    results = multicall3_aggregate(w3, calls, allow_failure=False)
    if len(results) != 3:
        raise RuntimeError(f"expected 3 multicall results, got {len(results)}")
    price = int.from_bytes(results[0][:32], "big")
    buyer_discount_bps = int.from_bytes(results[1][:32], "big")
    referral_bps = int.from_bytes(results[2][:32], "big")
    block_number = w3.eth.block_number
    return price, buyer_discount_bps, referral_bps, block_number


def run_if_needed() -> None:
    """Initialize ``app_state.access_config`` from on-chain reads (once)."""

    if not config.access_contract:
        log.info("access_bootstrap.skip", reason="ACCESS_CONTRACT not set")
        return

    try:
        existing = state.get_json_key("access_config")
        if existing is not None:
            log.info("access_bootstrap.skip", reason="access_config already present")
            return

        price, discount, ref, block_number = _read_snapshot()
        snapshot = {
            "accessPriceWei": str(price),
            "buyerDiscountBps": int(discount),
            "referralBps": int(ref),
            "blockNumber": int(block_number),
            "txHash": None,
        }
        state.set_json_key("access_config", snapshot)
        log.info(
            "access_bootstrap.write",
            accessPriceWei=snapshot["accessPriceWei"],
            buyerDiscountBps=snapshot["buyerDiscountBps"],
            referralBps=snapshot["referralBps"],
            blockNumber=snapshot["blockNumber"],
        )

        # Also pin the scan cursor for access_event_loop so the first tick
        # doesn't try to scan from block 0.
        existing_cursor = state.get_json_key("access_last_scanned_block")
        if existing_cursor is None:
            cursor_block = (
                config.access_deploy_block if config.access_deploy_block > 0 else block_number
            )
            state.set_int_key("access_last_scanned_block", cursor_block)
            log.info("access_bootstrap.cursor_init", block=cursor_block)
    except Exception:
        log.exception("access_bootstrap.failed")


__all__ = ["run_if_needed"]
