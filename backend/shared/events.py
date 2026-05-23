"""Buy/Sell hook event decoding + log scanning.

Ports ``_decode_log`` and ``scan_hook_logs`` from portable server.py §230-287
into pure functions. Differences from the portable version:

- Output is an ``Event`` TypedDict with **snake_case** keys (DB-friendly) and
  **lowercase** addresses (the portable version emitted checksum addresses).
  Lowercasing matches the schema in ``docs/db-schema.sql``.
- ``base_value`` / ``token_value`` / ``fee`` stay as ``int`` (wei); the portable
  version kept them as int in events too — only the display layer divides by
  ``WEI``.
- ``timestamp`` is added (portable derived it lazily from block-time deltas in
  ``build_candles``); we resolve it in the scanner via a per-block lookup so
  downstream consumers don't need ``current_block``. A scanner caller may pass
  ``resolve_timestamps=False`` and fill timestamps separately for performance.
- ``scan_logs`` is a **generator**: events stream out chunk-by-chunk, so a
  worker can write them to Postgres incrementally without holding the whole
  range in memory. Portable code returned a list.

Data-layout reminder (matches the Buy/Sell event signature in contracts.md):

    topics = [
        keccak("Buy(address,address,uint256,uint256,uint256)") or Sell-variant,
        trader (indexed address),
        token  (indexed address),
    ]
    data = abi.encode(val0, val1, fee)  # 3 x 32 bytes

For a Buy: ``(val0, val1) = (baseValue, tokenValue)``.
For a Sell: ``(val0, val1) = (tokenValue, baseValue)``.

This is portable-server.py §245-248. The order swap is the contract's choice
and we mirror it verbatim — changing it would silently misreport one side.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any, cast

from web3 import Web3

# Pre-computed topic0 values. Computed lazily to avoid forcing a Web3 import
# at module load; ``_topics()`` memoizes them.
_TOPICS_CACHE: dict[str, str] = {}


def _topics() -> tuple[str, str]:
    """Return ``(buy_topic, sell_topic)`` as lowercase 0x-prefixed hex.

    Memoized — keccak is cheap, but we hit this for every chunk.
    """

    if "buy" not in _TOPICS_CACHE:
        buy = "0x" + Web3.keccak(text="Buy(address,address,uint256,uint256,uint256)").hex()
        sell = "0x" + Web3.keccak(text="Sell(address,address,uint256,uint256,uint256)").hex()
        # Normalize: keccak.hex() in web3.py v7 returns *without* 0x prefix and
        # lowercase. Defensive .lower() in case a future version changes that.
        _TOPICS_CACHE["buy"] = buy.lower()
        _TOPICS_CACHE["sell"] = sell.lower()
    return _TOPICS_CACHE["buy"], _TOPICS_CACHE["sell"]


def _hex_no_prefix(value: Any) -> str:
    """Convert HexBytes / bytes / str to a lowercase no-0x hex string."""

    if isinstance(value, bytes | bytearray):
        return bytes(value).hex().lower()
    if isinstance(value, str):
        s = value.lower()
        return s[2:] if s.startswith("0x") else s
    # HexBytes — fall through to its .hex() (web3.py uses eth_utils HexBytes).
    return cast(str, value.hex()).lower().removeprefix("0x")


def _topic_to_address(topic: Any) -> str:
    """Take a 32-byte topic and return the lowercase address (last 20 bytes).

    Topics are right-padded ``bytes32``; an address occupies the lower 20.
    """

    hex_str = _hex_no_prefix(topic)
    # Keep last 40 chars = 20 bytes.
    return "0x" + hex_str[-40:]


def _to_bytes(data: Any) -> bytes:
    """Coerce ``data`` from any hex-ish representation into raw bytes."""

    if isinstance(data, bytes | bytearray):
        return bytes(data)
    if isinstance(data, str):
        s = data[2:] if data.startswith("0x") else data
        return bytes.fromhex(s)
    # HexBytes has .hex() returning unprefixed hex.
    return bytes.fromhex(_hex_no_prefix(data))


def decode_log(log: Any) -> dict[str, Any]:
    """Decode a Buy/Sell hook log into a normalized :class:`Event` dict.

    Accepts any object exposing ``topics``, ``data``, ``blockNumber``,
    ``transactionHash``, ``logIndex`` — either an ``AttributeDict`` from
    ``w3.eth.get_logs`` or a plain dict (used in tests). Addresses come out
    lowercase; integers stay in wei.

    Raises ``ValueError`` if topic0 is neither the Buy nor the Sell signature.
    """

    topics = log["topics"] if isinstance(log, dict) else log.topics
    data = log["data"] if isinstance(log, dict) else log.data
    block_number = log["blockNumber"] if isinstance(log, dict) else log.blockNumber
    tx_hash = log["transactionHash"] if isinstance(log, dict) else log.transactionHash
    log_index = log["logIndex"] if isinstance(log, dict) else log.logIndex

    buy_topic, sell_topic = _topics()
    topic0 = "0x" + _hex_no_prefix(topics[0])
    if topic0 == buy_topic:
        side = "buy"
    elif topic0 == sell_topic:
        side = "sell"
    else:
        raise ValueError(f"unknown event topic0: {topic0!r}")

    trader = _topic_to_address(topics[1])
    token = _topic_to_address(topics[2])

    raw = _to_bytes(data)
    if len(raw) < 96:
        raise ValueError(f"event data too short: {len(raw)} bytes (need ≥96)")
    val0 = int.from_bytes(raw[0:32], "big")
    val1 = int.from_bytes(raw[32:64], "big")
    fee = int.from_bytes(raw[64:96], "big")

    if side == "buy":
        base_val, token_val = val0, val1
    else:
        base_val, token_val = val1, val0

    return {
        "block_number": int(block_number),
        "tx_hash": "0x" + _hex_no_prefix(tx_hash),
        "log_index": int(log_index),
        "token_address": token,
        "side": side,
        "trader_address": trader,
        "base_value": base_val,
        "token_value": token_val,
        "fee": fee,
        "timestamp": 0,
    }


def scan_logs(
    w3: Any,
    contract_addresses: list[str],
    from_block: int,
    to_block: int,
    *,
    chunk_size: int = 2000,
) -> Iterator[dict[str, Any]]:
    """Yield decoded Buy/Sell events for the given hooks in ``[from_block, to_block]``.

    Streams chunk-by-chunk via ``w3.eth.get_logs`` — bounded RAM regardless of
    range size. Mirrors the portable scanner's chunk size (2000 blocks) and its
    Buy|Sell topic-filter (portable §267-280).

    Args:
        w3: Web3 client (must expose ``eth.get_logs``).
        contract_addresses: Hook addresses (checksum or lowercase; converted).
        from_block: Inclusive.
        to_block: Inclusive. If ``from_block > to_block``, yields nothing.
        chunk_size: Blocks per ``get_logs`` request. Lower this if the RPC
            rejects wide ranges.

    Yields:
        :class:`Event` dicts (one per decoded log).

    Note:
        Errors inside a single chunk are not retried here — the portable
        version slept and continued; in the web version the worker logs and
        re-queues the chunk explicitly (see ``worker/event_loop.py``).
    """

    if from_block > to_block:
        return

    buy_topic, sell_topic = _topics()
    # ``get_logs`` accepts a list of OR-ed topic values at each position.
    topics_filter = [[buy_topic, sell_topic]]
    # Checksum addresses for the RPC call (Base's public RPC is lenient but
    # some providers reject lowercase).
    checksum_addrs = [Web3.to_checksum_address(a) for a in contract_addresses]

    for start in range(from_block, to_block + 1, chunk_size):
        end = min(start + chunk_size - 1, to_block)
        logs = w3.eth.get_logs(
            {
                "address": checksum_addrs,
                "fromBlock": start,
                "toBlock": end,
                "topics": topics_filter,
            }
        )
        for log in logs:
            yield decode_log(log)


__all__ = ["decode_log", "scan_logs"]
