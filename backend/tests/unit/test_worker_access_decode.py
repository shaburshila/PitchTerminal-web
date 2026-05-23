"""Unit tests for :mod:`worker.access_decode`.

Verifies the topic0 routing and the data-payload decoding for both events
emitted from PitchTerminalAccess (``PriceChanged``, ``ReferralSplitUpdated``)
plus the silent-skip path for irrelevant events.
"""

from __future__ import annotations

from web3 import Web3

from worker.access_decode import decode_access_log


def _topic_price() -> str:
    return "0x" + Web3.keccak(text="PriceChanged(uint256)").hex()


def _topic_referral() -> str:
    return "0x" + Web3.keccak(text="ReferralSplitUpdated(uint16,uint16)").hex()


def _pad32(n: int) -> str:
    return n.to_bytes(32, "big").hex()


def test_decode_price_changed_basic() -> None:
    log = {
        "topics": [_topic_price()],
        "data": "0x" + _pad32(2_000_000_000_000_000_000),  # 2e18
        "blockNumber": 12345,
        "transactionHash": "0x" + "ab" * 32,
        "logIndex": 7,
    }
    ev = decode_access_log(log)
    assert ev is not None
    assert ev["kind"] == "price_changed"
    assert ev["new_price"] == 2_000_000_000_000_000_000
    assert ev["new_buyer_discount_bps"] is None
    assert ev["new_referral_bps"] is None
    assert ev["block_number"] == 12345
    assert ev["tx_hash"] == "0x" + "ab" * 32
    assert ev["log_index"] == 7


def test_decode_referral_split_updated() -> None:
    log = {
        "topics": [_topic_referral()],
        "data": "0x" + _pad32(2500) + _pad32(2500),
        "blockNumber": 999,
        "transactionHash": "0x" + "cd" * 32,
        "logIndex": 0,
    }
    ev = decode_access_log(log)
    assert ev is not None
    assert ev["kind"] == "referral_split_updated"
    assert ev["new_buyer_discount_bps"] == 2500
    assert ev["new_referral_bps"] == 2500
    assert ev["new_price"] is None


def test_decode_referral_split_kill_switch() -> None:
    """``setReferralSplit(0, 0)`` → kill-switch path."""

    log = {
        "topics": [_topic_referral()],
        "data": "0x" + _pad32(0) + _pad32(0),
        "blockNumber": 1,
        "transactionHash": "0x" + "01" * 32,
        "logIndex": 0,
    }
    ev = decode_access_log(log)
    assert ev is not None
    assert ev["new_buyer_discount_bps"] == 0
    assert ev["new_referral_bps"] == 0


def test_decode_unknown_topic_returns_none() -> None:
    """AccessPurchased / AccessGranted / etc → silent skip."""

    log = {
        "topics": ["0x" + "ff" * 32],
        "data": "0x",
        "blockNumber": 1,
        "transactionHash": "0x" + "00" * 32,
        "logIndex": 0,
    }
    assert decode_access_log(log) is None


def test_decode_handles_bytes_topic_and_data() -> None:
    """Real ``w3.eth.get_logs`` returns HexBytes-like objects, not strings."""

    topic_bytes = bytes.fromhex(_topic_price()[2:])
    log = {
        "topics": [topic_bytes],
        "data": bytes.fromhex(_pad32(42)),
        "blockNumber": 5,
        "transactionHash": bytes.fromhex("ab" * 32),
        "logIndex": 1,
    }
    ev = decode_access_log(log)
    assert ev is not None
    assert ev["kind"] == "price_changed"
    assert ev["new_price"] == 42
    assert ev["tx_hash"] == "0x" + "ab" * 32


def test_decode_raises_on_short_price_data() -> None:
    log = {
        "topics": [_topic_price()],
        "data": "0x" + "00" * 10,  # <32 bytes
        "blockNumber": 1,
        "transactionHash": "0x" + "00" * 32,
        "logIndex": 0,
    }
    try:
        decode_access_log(log)
    except ValueError as exc:
        assert "too short" in str(exc)
    else:
        raise AssertionError("expected ValueError on short data")


def test_decode_raises_on_short_referral_data() -> None:
    log = {
        "topics": [_topic_referral()],
        "data": "0x" + _pad32(100),  # only 32 bytes, need 64
        "blockNumber": 1,
        "transactionHash": "0x" + "00" * 32,
        "logIndex": 0,
    }
    try:
        decode_access_log(log)
    except ValueError as exc:
        assert "too short" in str(exc)
    else:
        raise AssertionError("expected ValueError on short data")
