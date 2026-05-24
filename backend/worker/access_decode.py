"""Decode ``PriceChanged`` and ``ReferralSplitUpdated`` from PitchTerminalAccess.

These are emitted only from the access contract (`config.access_contract`) and
are NOT Buy/Sell hook events, so they don't fit through
:func:`shared.events.scan_logs` (which hard-filters topic0 to Buy/Sell).

Event signatures (see ``docs/contracts.md`` §1):

* ``PriceChanged(uint256 newPrice)`` — one non-indexed uint256, 32 bytes data.
* ``ReferralSplitUpdated(uint16 newBuyerDiscountBps, uint16 newReferralBps)``
  — two non-indexed uint16, padded to 32 bytes each → 64 bytes data.

A decoded record is the minimal info needed by ``worker.access_event_loop`` to
react: which event fired, plus block & tx for cursor / idempotency.
"""

from __future__ import annotations

import functools
from typing import Any, Literal, TypedDict

from web3 import Web3


class AccessEvent(TypedDict):
    """Decoded access-contract event."""

    kind: Literal["price_changed", "referral_split_updated"]
    block_number: int
    tx_hash: str  # lowercase 0x-prefixed
    log_index: int
    # PriceChanged payload (None for the other kind):
    new_price: int | None
    # ReferralSplitUpdated payload (None for the other kind):
    new_buyer_discount_bps: int | None
    new_referral_bps: int | None


@functools.cache
def _topics() -> tuple[str, str]:
    """``(price_changed_topic, referral_split_topic)`` — lowercase 0x-prefixed."""

    pc = "0x" + Web3.keccak(text="PriceChanged(uint256)").hex()
    rs = "0x" + Web3.keccak(text="ReferralSplitUpdated(uint16,uint16)").hex()
    return pc.lower(), rs.lower()


def _to_bytes(data: Any) -> bytes:
    if isinstance(data, bytes | bytearray):
        return bytes(data)
    if isinstance(data, str):
        s = data.lower()
        s = s[2:] if s.startswith("0x") else s
        return bytes.fromhex(s)
    # HexBytes
    return bytes.fromhex(data.hex() if hasattr(data, "hex") else str(data))


def _hex_str(value: Any) -> str:
    if isinstance(value, bytes | bytearray):
        return "0x" + bytes(value).hex().lower()
    if isinstance(value, str):
        s = value.lower()
        return s if s.startswith("0x") else "0x" + s
    # HexBytes (or any object with a .hex() method)
    hex_value: str = value.hex()
    return "0x" + hex_value.lower()


def decode_access_log(log: Any) -> AccessEvent | None:
    """Decode a PitchTerminalAccess event log.

    Returns ``None`` for events we don't care about (``AccessPurchased``,
    ``AccessGranted``, ``AccessRevoked``, ``OwnershipTransferred``…). Those
    fire from the same contract address but don't affect the
    ``app_state.access_config`` snapshot.

    Raises ``ValueError`` on malformed log shape.
    """

    topics = log["topics"] if isinstance(log, dict) else log.topics
    data = log["data"] if isinstance(log, dict) else log.data
    block_number = log["blockNumber"] if isinstance(log, dict) else log.blockNumber
    tx_hash_raw = log["transactionHash"] if isinstance(log, dict) else log.transactionHash
    log_index = log["logIndex"] if isinstance(log, dict) else log.logIndex

    if not topics:
        raise ValueError("event log has no topics")

    pc_topic, rs_topic = _topics()
    topic0 = _hex_str(topics[0])

    if topic0 == pc_topic:
        raw = _to_bytes(data)
        if len(raw) < 32:
            raise ValueError(f"PriceChanged data too short: {len(raw)} bytes (need ≥32)")
        new_price = int.from_bytes(raw[0:32], "big")
        return AccessEvent(
            kind="price_changed",
            block_number=int(block_number),
            tx_hash=_hex_str(tx_hash_raw),
            log_index=int(log_index),
            new_price=new_price,
            new_buyer_discount_bps=None,
            new_referral_bps=None,
        )

    if topic0 == rs_topic:
        raw = _to_bytes(data)
        if len(raw) < 64:
            raise ValueError(f"ReferralSplitUpdated data too short: {len(raw)} bytes (need ≥64)")
        # Each uint16 is right-aligned in its 32-byte slot; reading the full 32
        # bytes as big-endian and casting to int gives the value (no masking
        # needed because the high bits are zero by the encoding rule).
        new_discount = int.from_bytes(raw[0:32], "big")
        new_referral = int.from_bytes(raw[32:64], "big")
        return AccessEvent(
            kind="referral_split_updated",
            block_number=int(block_number),
            tx_hash=_hex_str(tx_hash_raw),
            log_index=int(log_index),
            new_price=None,
            new_buyer_discount_bps=new_discount,
            new_referral_bps=new_referral,
        )

    # Some other event (AccessPurchased / AccessGranted / OwnershipTransferred / …).
    return None


__all__ = ["AccessEvent", "decode_access_log"]
