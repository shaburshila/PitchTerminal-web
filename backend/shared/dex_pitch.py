"""External-PITCH DEX swap decoding + classification (pure functions).

An *external* PITCH swap is PITCH bought / sold for ETH / WETH / USDC on a
DEX (Uniswap V3 pool or V4 PoolManager). This is the money-in / money-out leg
we need for a money-weighted ROI — distinct from in-app PITCH<->country /
player bonding-curve trades (already in the ``events`` table).

We do NOT classify by pool address (the V4 PoolManager is shared with in-app
country swaps). Instead we look at **token flow within one transaction**:

* external BUY  — PITCH transferred TO the trader, AND in the same tx either
  WETH/USDC transferred FROM the trader, OR native ETH funded the tx
  (``tx.value > 0``, the router wraps it). Quote = the WETH/USDC out (or the
  native ETH, represented as the WETH address with the wei amount).
* external SELL — PITCH transferred FROM the trader, AND WETH/USDC transferred
  TO the trader in the same tx.
* NOT external  — PITCH<->country (no WETH/USDC in the tx), pack-opening
  (PITCH out, no WETH/USDC, nothing back), plain PITCH transfer to an EOA.

The classifier is a **pure function** over decoded ERC20 ``Transfer`` logs
(PITCH + WETH + USDC) plus an optional ``tx_value`` lookup for the
native-ETH-funded buys. This makes it unit-testable with synthetic logs AND
runnable against real on-chain logs for validation.

Multi-leg dedupe: a single swap may deliver PITCH in 2+ legs to the trader.
We aggregate all PITCH legs for the SAME (tx_hash, trader, direction) into ONE
trade row, summing ``pitch_amount`` and ``quote_amount``, keyed by the MIN
PITCH log_index (for the ``UNIQUE(tx_hash, log_index)`` constraint).
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

from shared.config import (
    ERC20_TRANSFER_TOPIC,
    PITCH_TOKEN_ADDR,
    USDC_ADDR,
    WETH_ADDR,
)
from shared.eth import lc

# Normalize the canonical addresses once.
_PITCH = PITCH_TOKEN_ADDR.lower()
_WETH = WETH_ADDR.lower()
_USDC = USDC_ADDR.lower()
_QUOTE_TOKENS = frozenset({_WETH, _USDC})
_TRANSFER_TOPIC = ERC20_TRANSFER_TOPIC.lower()


@dataclass(frozen=True)
class TransferLog:
    """A decoded ERC20 ``Transfer(from, to, value)`` log (lowercase addrs)."""

    block_number: int
    tx_hash: str
    log_index: int
    token: str  # the ERC20 contract that emitted the Transfer
    from_addr: str
    to_addr: str
    value: int


@dataclass(frozen=True)
class DexTrade:
    """One aggregated external-PITCH trade row (per tx + trader + direction)."""

    block_number: int
    tx_hash: str
    log_index: int  # MIN PITCH-leg log_index in the tx
    trader_address: str
    direction: str  # 'buy' | 'sell'
    pitch_amount: int
    quote_token: str
    quote_amount: int


def _hex_no_prefix(value: Any) -> str:
    if isinstance(value, bytes | bytearray):
        return bytes(value).hex().lower()
    if isinstance(value, str):
        s = value.lower()
        return s[2:] if s.startswith("0x") else s
    raise TypeError(f"_hex_no_prefix: unsupported type {type(value).__name__}")


def _topic_to_address(topic: Any) -> str:
    """Right-padded ``bytes32`` topic → lowercase 0x address (low 20 bytes)."""

    return "0x" + _hex_no_prefix(topic)[-40:]


def _to_int(data: Any) -> int:
    """Decode the 32-byte ``value`` field of a Transfer log to int."""

    if isinstance(data, int):
        return int(data)
    if isinstance(data, bytes | bytearray):
        return int.from_bytes(bytes(data), "big")
    s = _hex_no_prefix(data)
    return int(s, 16) if s else 0


def decode_transfer_log(log: Any) -> TransferLog | None:
    """Decode one ERC20 ``Transfer`` log into a :class:`TransferLog`.

    Accepts an ``AttributeDict`` (from ``w3.eth.get_logs``) or a plain dict
    (tests). Returns ``None`` if the log is not a 3-topic ERC20 Transfer (so
    callers can pass mixed log streams without pre-filtering).
    """

    topics = log["topics"] if isinstance(log, dict) else log.topics
    if len(topics) < 3:
        return None
    topic0 = "0x" + _hex_no_prefix(topics[0])
    if topic0 != _TRANSFER_TOPIC:
        return None

    address = log["address"] if isinstance(log, dict) else log.address
    data = log["data"] if isinstance(log, dict) else log.data
    block_number = log["blockNumber"] if isinstance(log, dict) else log.blockNumber
    tx_hash = log["transactionHash"] if isinstance(log, dict) else log.transactionHash
    log_index = log["logIndex"] if isinstance(log, dict) else log.logIndex

    return TransferLog(
        block_number=int(block_number),
        tx_hash="0x" + _hex_no_prefix(tx_hash),
        log_index=int(log_index),
        token=lc("0x" + _hex_no_prefix(address)[-40:]),
        from_addr=_topic_to_address(topics[1]),
        to_addr=_topic_to_address(topics[2]),
        value=_to_int(data),
    )


def classify_external_pitch_trades(
    transfers: Iterable[TransferLog],
    *,
    tx_value: dict[str, int] | None = None,
    tx_from: dict[str, str] | None = None,
) -> list[DexTrade]:
    """Pure classifier: decoded Transfer logs → external-PITCH trade rows.

    Args:
        transfers: PITCH + WETH + USDC ``Transfer`` logs over a block range.
            Logs for OTHER tokens are ignored (defensive). Order irrelevant.
        tx_value: ``{tx_hash -> native ETH wei}`` for txs that needed a
            ``getTransactionByHash`` lookup (the native-ETH-funded buys). Only
            consulted for candidate buy-txs that have a PITCH-in leg but NO
            WETH/USDC counter-leg. Missing entry ⇒ treated as 0.
        tx_from: ``{tx_hash -> EOA}`` overriding the inferred trader. For these
            DEX swaps the trader is ``tx.from``; when supplied we trust it,
            otherwise we infer the non-PITCH-contract counterparty (the
            consistent address across the PITCH legs).

    Returns:
        Aggregated :class:`DexTrade` rows, one per (tx, trader, direction),
        sorted by ``(block_number, log_index)`` for stable output.

    Classification (per tx):
        * Collect PITCH transfers and quote (WETH/USDC) transfers in the tx.
        * If no PITCH transfer ⇒ not external (skip).
        * Determine the trader (``tx_from`` override, else the address that is
          consistently a party to the PITCH legs and is NOT a quote/PITCH
          contract — in practice the EOA initiating the swap).
        * BUY: trader receives PITCH. Quote = sum of (WETH/USDC FROM trader);
          if none, fall back to native ETH (``tx_value`` > 0) as WETH.
        * SELL: trader sends PITCH. Quote = sum of (WETH/USDC TO trader).
        * If the candidate has no quote leg AND no native ETH ⇒ NOT external
          (in-app country swap / pack-open / plain transfer): skip.
    """

    tx_value = tx_value or {}
    tx_from = tx_from or {}

    # Bucket transfers per tx.
    by_tx: dict[str, list[TransferLog]] = defaultdict(list)
    for t in transfers:
        if t.token not in (_PITCH, _WETH, _USDC):
            continue
        by_tx[t.tx_hash].append(t)

    out: list[DexTrade] = []
    for tx_hash, logs in by_tx.items():
        pitch_legs = [t for t in logs if t.token == _PITCH]
        if not pitch_legs:
            continue
        quote_legs = [t for t in logs if t.token in _QUOTE_TOKENS]

        trader = _resolve_trader(tx_hash, pitch_legs, quote_legs, tx_from)
        if trader is None:
            continue

        # PITCH legs touching the trader, split by direction.
        pitch_in = [t for t in pitch_legs if t.to_addr == trader]
        pitch_out = [t for t in pitch_legs if t.from_addr == trader]

        # A single external swap is one-directional for PITCH from the trader's
        # POV. If somehow both, prefer the larger leg-set (defensive; real
        # swaps never do both).
        if pitch_in and not pitch_out:
            trade = _build_buy(tx_hash, trader, pitch_in, quote_legs, tx_value)
        elif pitch_out and not pitch_in:
            trade = _build_sell(tx_hash, trader, pitch_out, quote_legs)
        else:
            # PITCH not net to/from this trader (e.g. pool is the trader, or
            # ambiguous) — not an external user trade.
            trade = None

        if trade is not None:
            out.append(trade)

    out.sort(key=lambda d: (d.block_number, d.log_index))
    return out


def _resolve_trader(
    tx_hash: str,
    pitch_legs: list[TransferLog],
    quote_legs: list[TransferLog],
    tx_from: dict[str, str],
) -> str | None:
    """Pick the trader EOA for a tx.

    Prefer the explicit ``tx_from`` override (these DEX swaps are initiated by
    the trader; the worker always supplies it). Otherwise infer best-effort:
    the trader is the address that appears on the most legs (PITCH + quote),
    excluding the known token contracts. NOTE: a plain 2-party single-pool swap
    is symmetric (trader and pool each touch the same number of legs), so
    direction inference is genuinely ambiguous without ``tx.from`` — that is why
    the worker supplies the override. This fallback exists for validation
    scripts and multi-party aggregator txs.
    """

    override = tx_from.get(tx_hash)
    if override:
        return lc(override)

    counts: dict[str, int] = defaultdict(int)
    for t in (*pitch_legs, *quote_legs):
        for party in (t.from_addr, t.to_addr):
            if party in (_PITCH, _WETH, _USDC):
                continue
            counts[party] += 1
    if not counts:
        return None
    # Deterministic: most-referenced party, ties broken by address ordering.
    return max(counts, key=lambda a: (counts[a], a))


def _build_buy(
    tx_hash: str,
    trader: str,
    pitch_in: list[TransferLog],
    quote_legs: list[TransferLog],
    tx_value: dict[str, int],
) -> DexTrade | None:
    pitch_amount = sum(t.value for t in pitch_in)
    if pitch_amount <= 0:
        return None
    min_li = min(t.log_index for t in pitch_in)
    block = min(t.block_number for t in pitch_in)

    # Quote = WETH/USDC leaving the trader. Prefer a single quote token; if both
    # appear, pick the one with the larger total (real swaps use one).
    from_trader = [t for t in quote_legs if t.from_addr == trader]
    quote_token, quote_amount = _pick_quote(from_trader)

    if quote_token is None:
        # No ERC20 quote leg from the trader → native-ETH-funded buy.
        native = int(tx_value.get(tx_hash, 0))
        if native <= 0:
            # No WETH/USDC and no native ETH ⇒ in-app country swap /
            # pack-open / plain transfer. NOT external.
            return None
        quote_token, quote_amount = _WETH, native

    return DexTrade(
        block_number=block,
        tx_hash=tx_hash,
        log_index=min_li,
        trader_address=trader,
        direction="buy",
        pitch_amount=pitch_amount,
        quote_token=quote_token,
        quote_amount=quote_amount,
    )


def _build_sell(
    tx_hash: str,
    trader: str,
    pitch_out: list[TransferLog],
    quote_legs: list[TransferLog],
) -> DexTrade | None:
    pitch_amount = sum(t.value for t in pitch_out)
    if pitch_amount <= 0:
        return None
    min_li = min(t.log_index for t in pitch_out)
    block = min(t.block_number for t in pitch_out)

    # Quote = WETH/USDC arriving at the trader.
    to_trader = [t for t in quote_legs if t.to_addr == trader]
    quote_token, quote_amount = _pick_quote(to_trader)
    if quote_token is None:
        # PITCH out, no WETH/USDC back ⇒ in-app country swap / pack-open /
        # plain transfer. NOT external. (Native ETH cannot be RECEIVED via an
        # ERC20 sell without a WETH unwrap Transfer, which would itself be a
        # WETH leg, so there is no native-ETH sell branch.)
        return None

    return DexTrade(
        block_number=block,
        tx_hash=tx_hash,
        log_index=min_li,
        trader_address=trader,
        direction="sell",
        pitch_amount=pitch_amount,
        quote_token=quote_token,
        quote_amount=quote_amount,
    )


def _pick_quote(legs: list[TransferLog]) -> tuple[str | None, int]:
    """Sum quote legs, returning the dominant (token, total). None if empty."""

    if not legs:
        return None, 0
    totals: dict[str, int] = defaultdict(int)
    for t in legs:
        totals[t.token] += t.value
    token = max(totals, key=lambda a: totals[a])
    return token, totals[token]


__all__ = [
    "DexTrade",
    "TransferLog",
    "classify_external_pitch_trades",
    "decode_transfer_log",
]
