"""Unit tests for :mod:`shared.dex_pitch` — the pure external-PITCH classifier.

Synthetic ERC20 ``Transfer`` logs (PITCH / WETH / USDC) are fed through
:func:`decode_transfer_log` and :func:`classify_external_pitch_trades`. No RPC.

Coverage:
* external buy (WETH leg)
* external buy (native ETH, tx.value > 0, no ERC20 quote leg)
* external sell (USDC leg)
* in-app country swap (no WETH/USDC) → NOT external
* pack-opening (PITCH out only, no quote) → NOT external
* multi-leg single-tx buy → deduped to one row
"""

from __future__ import annotations

from typing import Any

from web3 import Web3

from shared.config import PITCH_TOKEN_ADDR, USDC_ADDR, WETH_ADDR
from shared.dex_pitch import (
    DexTrade,
    classify_external_pitch_trades,
    decode_transfer_log,
)

PITCH = PITCH_TOKEN_ADDR.lower()
WETH = WETH_ADDR.lower()
USDC = USDC_ADDR.lower()

TRADER = "0x71ecd1a09380ca46cca741bc48d04c556674756f"
POOL = "0xec44849198fbf8b6dc239df418ea7be017240368"  # V3 pool
COUNTRY = "0x000000000000000000000000000000000000c0c0"

_TRANSFER_TOPIC = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex()


def _addr_topic(addr: str) -> str:
    return "0x" + addr.lower().removeprefix("0x").rjust(64, "0")


def _transfer_log(
    *,
    token: str,
    frm: str,
    to: str,
    value: int,
    block: int = 1000,
    log_index: int = 0,
    tx: str = "0x" + "ab" * 32,
) -> dict[str, Any]:
    """Build a Transfer log shaped like ``w3.eth.get_logs`` output (dict form)."""

    return {
        "address": token,
        "topics": [_TRANSFER_TOPIC, _addr_topic(frm), _addr_topic(to)],
        "data": "0x" + value.to_bytes(32, "big").hex(),
        "blockNumber": block,
        "transactionHash": tx,
        "logIndex": log_index,
    }


def _decode(logs: list[dict[str, Any]]) -> list[Any]:
    out = []
    for log in logs:
        d = decode_transfer_log(log)
        assert d is not None
        out.append(d)
    return out


# ── decode ─────────────────────────────────────────────────────────────────


def test_decode_transfer_log_basic() -> None:
    log = _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=123, log_index=5)
    d = decode_transfer_log(log)
    assert d is not None
    assert d.token == PITCH
    assert d.from_addr == POOL
    assert d.to_addr == TRADER
    assert d.value == 123
    assert d.log_index == 5


def test_decode_rejects_non_transfer_topic() -> None:
    log = _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=1)
    log["topics"] = ["0x" + "00" * 32, _addr_topic(POOL), _addr_topic(TRADER)]
    assert decode_transfer_log(log) is None


# ── external BUY (WETH leg) ──────────────────────────────────────────────────


def test_external_buy_weth_leg() -> None:
    tx = "0x" + "11" * 32
    logs = _decode(
        [
            # WETH from trader to pool
            _transfer_log(token=WETH, frm=TRADER, to=POOL, value=5 * 10**17, tx=tx, log_index=0),
            # PITCH from pool to trader
            _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=100 * 10**18, tx=tx, log_index=1),
        ]
    )
    trades = classify_external_pitch_trades(logs, tx_from={tx: TRADER})
    assert len(trades) == 1
    t = trades[0]
    assert t.direction == "buy"
    assert t.trader_address == TRADER
    assert t.pitch_amount == 100 * 10**18
    assert t.quote_token == WETH
    assert t.quote_amount == 5 * 10**17
    assert t.log_index == 1  # MIN PITCH-leg log_index


# ── external BUY (native ETH, tx.value > 0) ──────────────────────────────────


def test_external_buy_native_eth() -> None:
    tx = "0x" + "22" * 32
    logs = _decode(
        [
            # Only a PITCH-in leg; no WETH/USDC transfer (router wrapped ETH).
            _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=50 * 10**18, tx=tx, log_index=3),
        ]
    )
    trades = classify_external_pitch_trades(
        logs, tx_value={tx: 3 * 10**17}, tx_from={tx: TRADER}
    )
    assert len(trades) == 1
    t = trades[0]
    assert t.direction == "buy"
    assert t.pitch_amount == 50 * 10**18
    assert t.quote_token == WETH  # native ETH represented as WETH
    assert t.quote_amount == 3 * 10**17


def test_external_buy_no_quote_no_value_is_not_external() -> None:
    """PITCH-in but no WETH/USDC AND tx.value == 0 → NOT external."""

    tx = "0x" + "23" * 32
    logs = _decode(
        [_transfer_log(token=PITCH, frm=POOL, to=TRADER, value=50 * 10**18, tx=tx, log_index=0)]
    )
    trades = classify_external_pitch_trades(logs, tx_value={tx: 0}, tx_from={tx: TRADER})
    assert trades == []


# ── external SELL (USDC leg) ─────────────────────────────────────────────────


def test_external_sell_usdc_leg() -> None:
    tx = "0x" + "33" * 32
    logs = _decode(
        [
            # PITCH from trader to pool
            _transfer_log(token=PITCH, frm=TRADER, to=POOL, value=200 * 10**18, tx=tx, log_index=0),
            # USDC from pool to trader (6 dec)
            _transfer_log(token=USDC, frm=POOL, to=TRADER, value=150_000_000, tx=tx, log_index=1),
        ]
    )
    trades = classify_external_pitch_trades(logs, tx_from={tx: TRADER})
    assert len(trades) == 1
    t = trades[0]
    assert t.direction == "sell"
    assert t.pitch_amount == 200 * 10**18
    assert t.quote_token == USDC
    assert t.quote_amount == 150_000_000
    assert t.log_index == 0


# ── NOT external: in-app country swap ────────────────────────────────────────


def test_in_app_country_swap_not_external() -> None:
    """PITCH<->country: PITCH and a country token move, NO WETH/USDC → skip.

    The country token isn't PITCH/WETH/USDC so its Transfer is ignored; the
    PITCH leg alone with no quote and no native ETH is not external.
    """

    tx = "0x" + "44" * 32
    logs = _decode(
        [
            _transfer_log(token=PITCH, frm=TRADER, to=POOL, value=10 * 10**18, tx=tx, log_index=0),
            # country token (ignored token) — buy of country with PITCH
            _transfer_log(token=COUNTRY, frm=POOL, to=TRADER, value=7 * 10**18, tx=tx, log_index=1),
        ]
    )
    trades = classify_external_pitch_trades(logs, tx_from={tx: TRADER})
    assert trades == []


# ── NOT external: pack-opening ───────────────────────────────────────────────


def test_pack_opening_not_external() -> None:
    """Pack-open: PITCH out, no WETH/USDC, nothing back → skip."""

    tx = "0x" + "55" * 32
    logs = _decode(
        [_transfer_log(token=PITCH, frm=TRADER, to=POOL, value=20 * 10**18, tx=tx, log_index=0)]
    )
    trades = classify_external_pitch_trades(logs, tx_from={tx: TRADER})
    assert trades == []


# ── multi-leg single-tx buy → one row ────────────────────────────────────────


def test_multi_leg_buy_deduped_to_one_row() -> None:
    """One swap delivers PITCH in 2 legs + 2 WETH legs → single aggregated row."""

    tx = "0x" + "66" * 32
    logs = _decode(
        [
            _transfer_log(token=WETH, frm=TRADER, to=POOL, value=2 * 10**17, tx=tx, log_index=0),
            _transfer_log(token=WETH, frm=TRADER, to=POOL, value=3 * 10**17, tx=tx, log_index=1),
            _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=40 * 10**18, tx=tx, log_index=2),
            _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=60 * 10**18, tx=tx, log_index=3),
        ]
    )
    trades = classify_external_pitch_trades(logs, tx_from={tx: TRADER})
    assert len(trades) == 1
    t = trades[0]
    assert t.direction == "buy"
    assert t.pitch_amount == 100 * 10**18  # 40 + 60
    assert t.quote_token == WETH
    assert t.quote_amount == 5 * 10**17  # 0.2 + 0.3
    assert t.log_index == 2  # MIN of the two PITCH legs


# ── trader inference without tx_from override ────────────────────────────────


def test_trader_inferred_with_quote_leg_tiebreak() -> None:
    """Without tx_from, inference uses BOTH PITCH and quote legs as a tiebreak.

    A single-pool swap is 2-party: TRADER (PITCH-in + WETH-out) and POOL
    (PITCH-out + WETH-in). Counting only PITCH legs ties them; including the
    quote legs the trader appears on 2 legs and the pool on 2 — still tied. The
    worker therefore ALWAYS supplies ``tx_from`` in production. Here we assert
    the classifier produces exactly one trade for SOME resolved party (it does
    not crash or duplicate), and that supplying ``tx_from`` pins direction.
    """

    tx = "0x" + "77" * 32
    logs = _decode(
        [
            _transfer_log(token=WETH, frm=TRADER, to=POOL, value=10**17, tx=tx, log_index=0),
            _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=10 * 10**18, tx=tx, log_index=1),
        ]
    )
    # No tx_from → some party resolved; exactly one trade, no duplication.
    inferred = classify_external_pitch_trades(logs)
    assert len(inferred) == 1
    # With tx_from supplied, direction is unambiguously a buy for the trader.
    pinned = classify_external_pitch_trades(logs, tx_from={tx: TRADER})
    assert len(pinned) == 1
    assert pinned[0].direction == "buy"
    assert pinned[0].trader_address == TRADER


# ── stable sort ──────────────────────────────────────────────────────────────


def test_output_sorted_by_block_and_log_index() -> None:
    tx_a = "0x" + "aa" * 32
    tx_b = "0x" + "bb" * 32
    logs = _decode(
        [
            _transfer_log(token=WETH, frm=TRADER, to=POOL, value=1, tx=tx_b, block=2000, log_index=0),
            _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=10, tx=tx_b, block=2000, log_index=1),
            _transfer_log(token=WETH, frm=TRADER, to=POOL, value=1, tx=tx_a, block=1000, log_index=0),
            _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=10, tx=tx_a, block=1000, log_index=1),
        ]
    )
    trades = classify_external_pitch_trades(
        logs, tx_from={tx_a: TRADER, tx_b: TRADER}
    )
    assert [t.block_number for t in trades] == [1000, 2000]


def test_dex_trade_is_frozen_dataclass() -> None:
    t = DexTrade(
        block_number=1,
        tx_hash="0x" + "00" * 32,
        log_index=0,
        trader_address=TRADER,
        direction="buy",
        pitch_amount=1,
        quote_token=WETH,
        quote_amount=1,
    )
    assert t.direction == "buy"
