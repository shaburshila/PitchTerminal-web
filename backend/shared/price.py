"""Market-price arithmetic.

Ports ``_market_price`` (portable server.py §355) verbatim. The portable code
operates on wei-denominated ``Decimal`` values then converts to float; we
follow the same precision discipline — see ``docs/port-from-portable.md`` §1.

The "fee-excluded market price" is the price *of the bonding curve* — what
moves on the chart — as opposed to the trade's *effective* (fee-inclusive)
price. See ``docs/architecture.md`` and the chart toolbar UX in
``docs/functional-spec.md``.
"""

from __future__ import annotations

from decimal import Decimal

from shared.config import WEI
from shared.types import Side


def market_price(side: Side, base_value: int, fee: int, token_value: int) -> float:
    """Fee-excluded bonding-curve price for a single trade, in *display* units.

    For a buy the trader **spent** ``base_value`` of base currency (which already
    includes the fee), so the curve actually moved by ``base_value - fee``. For
    a sell the trader **received** ``base_value`` net of the fee, so the curve
    moved by ``base_value + fee``. Hence:

    - buy:  ``(base - fee) / token``
    - sell: ``(base + fee) / token``

    Args:
        side: ``"buy"`` or ``"sell"``.
        base_value: Base-currency amount in wei.
        fee: Fee in wei (always positive).
        token_value: Token amount in wei.

    Returns:
        Display-unit price as ``float``. Returns ``0.0`` if ``token_value <= 0``
        (avoids ZeroDivisionError on malformed events; never happens on real
        hook logs but defensive for fuzz inputs and partial decodings).
    """

    if token_value <= 0:
        return 0.0

    base = Decimal(base_value)
    fee_d = Decimal(fee)
    token = Decimal(token_value)

    gross = (base - fee_d) if side == "buy" else (base + fee_d)
    return float(gross / token)


def current_price_of(
    player_price_in_country: float,
    country_price_in_pitch: float,
) -> float:
    """Convert a player's price-in-country into price-in-PITCH.

    Player tokens trade against their country token; country tokens trade against
    PITCH. So a player's PITCH price is the product (portable server.py "price
    chain" comment in MEMORY.md). Country tokens themselves: pass the country
    price directly — no conversion needed.

    Returns 0.0 if either input is non-positive (a missing price means the token
    is not in the snapshot, treat as «no data» rather than propagate nonsense).
    """

    if player_price_in_country <= 0 or country_price_in_pitch <= 0:
        return 0.0
    return player_price_in_country * country_price_in_pitch


def to_display_units(wei_value: int) -> float:
    """Convert a wei int to its 18-decimal float representation.

    Centralized so chart/PnL modules don't repeat ``Decimal(x) / Decimal(WEI)``.
    """

    return float(Decimal(wei_value) / Decimal(WEI))


__all__ = ["current_price_of", "market_price", "to_display_units"]
