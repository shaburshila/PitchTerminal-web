"""Unit tests for :mod:`shared.events`.

Hand-builds raw logs that match the Buy/Sell event signature in
``docs/contracts.md`` and feeds them through :func:`decode_log` and
:func:`scan_logs`. No real RPC.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

import pytest
from web3 import Web3

from shared.events import decode_log, scan_logs

# ---- Test fixtures ---------------------------------------------------------

TRADER = "0x71ecd1a09380ca46cca741bc48d04c556674756f"
TOKEN = "0x000000000000000000000000000000000000beef"
HOOK = "0x000000000000000000000000000000000000d00d"

BUY_TOPIC = "0x" + Web3.keccak(text="Buy(address,address,uint256,uint256,uint256)").hex()
SELL_TOPIC = "0x" + Web3.keccak(text="Sell(address,address,uint256,uint256,uint256)").hex()


def _addr_topic(addr: str) -> str:
    """Pad an address into a 32-byte topic (hex, 0x-prefixed)."""

    return "0x" + addr.lower().removeprefix("0x").rjust(64, "0")


def _u256(value: int) -> bytes:
    return value.to_bytes(32, "big")


def _make_log(
    *,
    side: str,
    trader: str = TRADER,
    token: str = TOKEN,
    base_value: int,
    token_value: int,
    fee: int,
    block_number: int = 1000,
    log_index: int = 0,
    tx_hash: str = "0x" + "ab" * 32,
) -> dict[str, Any]:
    """Construct a Buy/Sell log shaped like ``w3.eth.get_logs`` output."""

    if side == "buy":
        topic0 = BUY_TOPIC
        val0, val1 = base_value, token_value
    elif side == "sell":
        topic0 = SELL_TOPIC
        val0, val1 = token_value, base_value
    else:
        raise ValueError(side)

    data = _u256(val0) + _u256(val1) + _u256(fee)
    return {
        "topics": [topic0, _addr_topic(trader), _addr_topic(token)],
        "data": data,
        "blockNumber": block_number,
        "transactionHash": bytes.fromhex(tx_hash.removeprefix("0x")),
        "logIndex": log_index,
        "address": Web3.to_checksum_address(HOOK),
    }


# ---- decode_log ------------------------------------------------------------


class TestDecodeLog:
    def test_buy_basic(self) -> None:
        log = _make_log(side="buy", base_value=100, token_value=10, fee=5)
        ev = decode_log(log)
        assert ev["side"] == "buy"
        assert ev["trader_address"] == TRADER
        assert ev["token_address"] == TOKEN
        assert ev["base_value"] == 100
        assert ev["token_value"] == 10
        assert ev["fee"] == 5
        assert ev["block_number"] == 1000
        assert ev["log_index"] == 0
        assert ev["tx_hash"].startswith("0x") and len(ev["tx_hash"]) == 66
        assert ev["timestamp"] == 0

    def test_sell_swaps_val0_val1(self) -> None:
        """Sell encodes data as (token_value, base_value, fee) — see decoder."""

        log = _make_log(side="sell", base_value=200, token_value=25, fee=10)
        ev = decode_log(log)
        assert ev["side"] == "sell"
        assert ev["base_value"] == 200
        assert ev["token_value"] == 25
        assert ev["fee"] == 10

    def test_addresses_lowercased(self) -> None:
        mixed_trader = "0x71ECD1a09380cA46CcA741Bc48d04C556674756F"
        log = _make_log(side="buy", trader=mixed_trader, base_value=1, token_value=1, fee=0)
        ev = decode_log(log)
        assert ev["trader_address"] == mixed_trader.lower()

    def test_hex_string_data_accepted(self) -> None:
        """get_logs can return ``data`` as a 0x-hex string instead of bytes."""

        log = _make_log(side="buy", base_value=42, token_value=7, fee=1)
        log["data"] = "0x" + log["data"].hex()
        ev = decode_log(log)
        assert ev["base_value"] == 42
        assert ev["token_value"] == 7

    def test_unknown_topic0_raises(self) -> None:
        log = _make_log(side="buy", base_value=1, token_value=1, fee=0)
        log["topics"][0] = "0x" + "f" * 64
        with pytest.raises(ValueError, match="unknown event topic0"):
            decode_log(log)

    def test_truncated_data_raises(self) -> None:
        log = _make_log(side="buy", base_value=1, token_value=1, fee=0)
        log["data"] = b"\x00" * 60  # less than 3 x 32
        with pytest.raises(ValueError, match="data too short"):
            decode_log(log)

    def test_topic_as_hexstring_str(self) -> None:
        """Topic from JSON RPC can be a plain string — must still work."""

        log = _make_log(side="buy", base_value=3, token_value=2, fee=0)
        # already strings → no-op; but exercise the str branch of _to_bytes.
        log["topics"][0] = BUY_TOPIC.upper()  # case-insensitive
        ev = decode_log(log)
        assert ev["side"] == "buy"


# ---- scan_logs -------------------------------------------------------------


class _FakeEth:
    """Minimal ``w3.eth`` stand-in for scan_logs."""

    def __init__(self, logs_per_chunk: list[list[dict[str, Any]]]):
        self._logs_per_chunk = list(logs_per_chunk)
        self.calls: list[dict[str, Any]] = []

    def get_logs(self, filter_params: dict[str, Any]) -> list[dict[str, Any]]:
        self.calls.append(filter_params)
        if not self._logs_per_chunk:
            return []
        return self._logs_per_chunk.pop(0)


class _FakeW3:
    def __init__(self, eth: _FakeEth):
        self.eth = eth


class TestScanLogs:
    def test_empty_range_yields_nothing(self) -> None:
        eth = _FakeEth([])
        w3 = _FakeW3(eth)
        out: Iterable[dict[str, Any]] = scan_logs(w3, [HOOK], 100, 50)
        assert list(out) == []
        assert eth.calls == []

    def test_yields_one_per_log(self) -> None:
        logs = [
            _make_log(side="buy", base_value=10, token_value=1, fee=1, block_number=1, log_index=0),
            _make_log(
                side="sell", base_value=20, token_value=2, fee=2, block_number=2, log_index=0
            ),
        ]
        eth = _FakeEth([logs])
        w3 = _FakeW3(eth)
        events = list(scan_logs(w3, [HOOK], 1, 100))
        assert len(events) == 2
        assert events[0]["side"] == "buy"
        assert events[1]["side"] == "sell"

    def test_filter_includes_both_topics(self) -> None:
        eth = _FakeEth([[]])
        w3 = _FakeW3(eth)
        list(scan_logs(w3, [HOOK], 1, 100))
        assert len(eth.calls) == 1
        topics = eth.calls[0]["topics"]
        assert topics[0] == [BUY_TOPIC.lower(), SELL_TOPIC.lower()]

    def test_chunks_split_range(self) -> None:
        # Range 1..5000 with chunk_size 2000 → 3 chunks.
        eth = _FakeEth([[], [], []])
        w3 = _FakeW3(eth)
        list(scan_logs(w3, [HOOK], 1, 5000, chunk_size=2000))
        assert len(eth.calls) == 3
        assert eth.calls[0]["fromBlock"] == 1
        assert eth.calls[0]["toBlock"] == 2000
        assert eth.calls[1]["fromBlock"] == 2001
        assert eth.calls[1]["toBlock"] == 4000
        assert eth.calls[2]["fromBlock"] == 4001
        assert eth.calls[2]["toBlock"] == 5000

    def test_checksums_addresses(self) -> None:
        eth = _FakeEth([[]])
        w3 = _FakeW3(eth)
        list(scan_logs(w3, [HOOK.lower()], 1, 100))
        assert eth.calls[0]["address"] == [Web3.to_checksum_address(HOOK)]
