"""Shared TypedDicts for pure data shapes (events, candles, points, PnL).

These types are dictionary-based on purpose: the web layer serializes them to
JSON for the API responses (api-spec.md), and the worker writes them into
Postgres rows. Keeping them as ``TypedDict`` rather than ``@dataclass`` avoids
an extra conversion step in hot paths (chart rebuild, PnL on large event sets).

Field naming follows snake_case (DB-friendly), unlike the portable version's
camelCase dicts (``baseValue`` etc.). See ``docs/port-from-portable.md`` §1.
"""

from __future__ import annotations

from typing import Literal, TypedDict

Side = Literal["buy", "sell"]


class Event(TypedDict):
    """A single Buy/Sell event from a hook contract.

    Wei-denominated amounts (``base_value``, ``token_value``, ``fee``) are kept
    as ``int`` — float would lose precision for large supplies. Conversion to
    floating-point happens only at display time (``shared.chart``).

    ``timestamp`` is unix-seconds. The scanner may write a provisional value
    (block.timestamp from a batched ``eth_getBlockByNumber`` call); a later
    pass can refine it. ``0`` is a valid sentinel meaning «unknown».
    """

    block_number: int
    tx_hash: str  # lowercase 0x-prefixed hex
    log_index: int
    token_address: str  # lowercase
    side: Side
    trader_address: str  # lowercase
    base_value: int  # wei
    token_value: int  # wei
    fee: int  # wei
    timestamp: int  # unix seconds (0 = unknown)


class Candle(TypedDict):
    """OHLCV candle for ``lightweight-charts``.

    ``time`` is unix-seconds aligned to the timeframe bucket (e.g. for the 5m
    timeframe, ``time % 300 == 0``). Prices/volumes are floats in display units
    (base currency divided by ``WEI``).
    """

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class Point(TypedDict):
    """Single-trade point for the line chart."""

    time: int
    value: float


class WalletPosition(TypedDict):
    """Per-token wallet PnL summary.

    Realized PnL uses **average-cost basis** (``avg_buy = (spent - buy_fees) /
    bought``) — same formula as the portable version (server.py §765-795).
    ``avg_buy`` is the *market* price (fee-excluded) and is drawn as a chart
    overlay, so it must be in market-price terms.

    ``avg_net = (spent - received) / position`` is the net cost basis per held
    token. ``spent`` includes buy fees and ``received`` is net of sell fees, so
    ``avg_net`` is fee-inclusive — it's the break-even price.
    """

    address: str  # lowercase
    buys: int
    sells: int
    position: float  # net tokens held (display units)
    spent: float  # total base currency spent (incl. buy fees), display units
    received: float  # total base currency received (net of sell fees)
    bought: float  # gross tokens bought
    fees_paid: float  # all fees paid (buy + sell)
    avg_buy: float  # fee-excluded market avg buy price
    avg_net: float  # fee-inclusive net cost per held token (break-even)
    realized_pnl: float  # received - avg_buy * sold
    unrealized_pnl: float  # position * (current_price - avg_buy)
    total_pnl: float  # realized + unrealized
    first_trade_ts: int  # earliest event ts; 0 if no events


__all__ = [
    "Candle",
    "Event",
    "Point",
    "Side",
    "WalletPosition",
]
