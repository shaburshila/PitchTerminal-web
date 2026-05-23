"""Market-price arithmetic.

Ports ``_market_price`` (portable server.py §355) verbatim. The portable code
operates on wei-denominated ``Decimal`` values then converts to float; we
follow the same precision discipline — see ``docs/port-from-portable.md`` §1.

The "fee-excluded market price" is the price *of the bonding curve* — what
moves on the chart — as opposed to the trade's *effective* (fee-inclusive)
price. See ``docs/architecture.md`` and the chart toolbar UX in
``docs/functional-spec.md``.

Historical lookup (:func:`price_at_pitch`) backs the ``valueSeries`` step of
``GET /api/v1/profile`` — see ``docs/api-spec.md`` §6.1. The portable
implementation kept all events in-memory and did binary search; here we use
the ``events`` table directly (an index on ``(token_address, ts DESC)`` is
implied by ``events_token_block_idx`` which orders by ``block_number DESC``
— close enough since block order ≈ ts order on Base).
"""

from __future__ import annotations

from decimal import Decimal

from shared.config import WEI
from shared.db import fetch_one
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


# ─── Historical price lookup ────────────────────────────────────────────────


def _nearest_event_base_per_token(token_address: str, ts: int) -> float | None:
    """Look up the bonding-curve price (in *base*) of the most recent event
    on ``token_address`` with ``ts <= given_ts``.

    Returns ``None`` when the token has no events at-or-before ``ts``
    (typical for ``ts`` *before* the token's first trade — fall back to the
    earliest event in that case via :func:`_earliest_event_base_per_token`).
    "Base" is country for player tokens, PITCH for country tokens.
    """

    row = fetch_one(
        "SELECT side, base_value, token_value, fee "
        "FROM events "
        "WHERE token_address = %s AND ts <= to_timestamp(%s) "
        "ORDER BY ts DESC, block_number DESC, log_index DESC "
        "LIMIT 1",
        (token_address, ts),
    )
    if row is None:
        return None
    return market_price(
        row["side"],
        int(row["base_value"]),
        int(row["fee"]),
        int(row["token_value"]),
    )


def _earliest_event_base_per_token(token_address: str) -> float | None:
    """Fallback for :func:`_nearest_event_base_per_token` when ``ts`` precedes
    every event for the token — return the earliest event's base price."""

    row = fetch_one(
        "SELECT side, base_value, token_value, fee "
        "FROM events "
        "WHERE token_address = %s "
        "ORDER BY ts ASC, block_number ASC, log_index ASC "
        "LIMIT 1",
        (token_address,),
    )
    if row is None:
        return None
    return market_price(
        row["side"],
        int(row["base_value"]),
        int(row["fee"]),
        int(row["token_value"]),
    )


def _current_price_pitch_fallback(token_address: str) -> float:
    """Last-ditch fallback to ``market_state.price_pitch`` when the events
    table has no rows for the token at all. Returns ``0.0`` when even the
    cache row is missing."""

    row = fetch_one(
        "SELECT price_pitch FROM market_state WHERE token_address = %s",
        (token_address,),
    )
    if row is None:
        return 0.0
    return to_display_units(int(row["price_pitch"]))


def price_at_pitch(
    token_address: str,
    kind: str,
    country_address: str | None,
    ts: int,
) -> float:
    """Historical PITCH price of ``token_address`` at unix-second ``ts``.

    Semantics of "nearest": the *most recent* event with ``ts <= given_ts``.
    Step function — between events the price is the price set by the prior
    trade (this matches how the portable code's binary search behaved and
    is how exchanges typically display historical valuation).

    For player tokens, both the player→country price and the country→PITCH
    price are sampled independently at ``ts`` and multiplied (price chain).

    Args:
        token_address: Lowercase 0x address of the token to value.
        kind: ``"player"`` or ``"country"`` (from ``tokens.kind``).
        country_address: For player tokens, the lowercase 0x address of the
            associated country token. ``None`` (or empty) for country tokens.
        ts: Unix seconds — typically the timestamp of a wallet trade.

    Returns:
        Price in PITCH (display units). ``0.0`` when neither historical nor
        current data is available — the caller should treat the token as
        "no data" rather than propagate nonsense, mirroring
        :func:`current_price_of`.
    """

    base_price = _nearest_event_base_per_token(token_address, ts)
    if base_price is None:
        base_price = _earliest_event_base_per_token(token_address)
    if base_price is None or base_price <= 0:
        # No event history at all — degrade to the current spot price. The
        # series loses its time-axis fidelity for this token but stays
        # non-zero (matches the portable behaviour when ``price_tl`` was
        # empty for a token: portable returned 0, but exposing the latest
        # PITCH price is strictly more useful).
        return _current_price_pitch_fallback(token_address)

    if kind == "country":
        return base_price

    # Player: convert price-in-country to price-in-PITCH using the country's
    # PITCH price at the same ts.
    if not country_address:
        return 0.0
    country_pitch = _nearest_event_base_per_token(country_address, ts)
    if country_pitch is None:
        country_pitch = _earliest_event_base_per_token(country_address)
    if country_pitch is None or country_pitch <= 0:
        country_pitch = _current_price_pitch_fallback(country_address)
    return current_price_of(base_price, country_pitch)


__all__ = [
    "current_price_of",
    "market_price",
    "price_at_pitch",
    "to_display_units",
]
