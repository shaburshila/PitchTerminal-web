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
    """Single-trade point for the line chart.

    ``time`` is unix-seconds with a sub-second tick offset (``log_index *
    0.001``) to disambiguate multiple trades that share the same block
    timestamp. ``lightweight-charts`` requires strictly-increasing ``time``
    values across the series — if two trades have identical ``time`` the
    renderer crashes ("Value is null").
    """

    time: float
    value: float


class WalletPosition(TypedDict):
    """Per-token wallet PnL summary.

    Realized PnL uses **average-cost basis** with a fee-inclusive ``avg_buy =
    spent / bought`` (portable my_wallet parity — the user paid ``spent`` PITCH
    out of pocket, and the cost basis reflects that).

    ``avg_net = (spent - received) / position`` is the net cost basis per held
    token — what each remaining token "really cost" after recouping prior
    sells. Always fee-inclusive (both ``spent`` and ``received`` are gross).
    Surfaces as the break-even price.

    Fees are tracked separately in ``fees_paid`` so the UI can show them
    explicitly without double-counting them in the cost basis.
    """

    address: str  # lowercase
    buys: int
    sells: int
    position: float  # net tokens held (display units, clamped to >= 0)
    spent: float  # total base currency paid (incl. buy fees), display units
    received: float  # total base currency received (net of sell fees)
    bought: float  # gross tokens bought
    fees_paid: float  # all fees paid (buy + sell), surfaced separately
    avg_buy: float  # fee-inclusive avg buy price (spent / bought)
    avg_net: float  # net cost per held token (break-even)
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
