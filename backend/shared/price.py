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
implementation kept all events in-memory and did binary search. The per-call
:func:`price_at_pitch` reads the ``events`` table directly (served by the
``events_token_ts_idx`` index on ``(token_address, ts DESC)``); for the hot
``valueSeries`` path — which resolves a price at *every* wallet trade across
*every* held token — use :class:`HistoricalPrices`, which preloads all the
needed timelines in one query and does the same binary search in memory.
"""

from __future__ import annotations

import bisect
from collections.abc import Iterable
from decimal import Decimal

from shared.config import WEI
from shared.db import fetch_all, fetch_one
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


# ─── Batched in-memory historical lookup ─────────────────────────────────────


def load_price_timelines(token_addresses: Iterable[str]) -> dict[str, list[tuple[int, float]]]:
    """Preload per-token historical price timelines in a single query.

    Returns ``{token_address: [(ts, native_market_price), ...]}`` where each
    list is sorted ascending by ``(ts, block_number, log_index)`` — exactly the
    order :class:`HistoricalPrices` binary-searches. "Native" price is the base
    currency of the token (country-units for player tokens, PITCH for country
    tokens), i.e. :func:`market_price` of the event — the same value
    :func:`_nearest_event_base_per_token` returns per call.

    Rows with NULL ``ts`` (not-yet-resolved events) are excluded, matching the
    per-call lookup's ``WHERE ts <= ...`` predicate which never matches NULL.
    Events with ``token_value <= 0`` are kept (``market_price`` yields ``0.0``
    for them) so the "nearest" sample matches the per-call query, which also
    does not filter on ``token_value`` — the resolver then treats a ``<= 0``
    nearest price as «no data» and falls back, just like :func:`price_at_pitch`.
    """

    addrs = sorted({a for a in token_addresses})
    if not addrs:
        return {}
    placeholders = ",".join(["%s"] * len(addrs))
    rows = fetch_all(
        f"SELECT token_address, side, base_value, token_value, fee, "
        f"EXTRACT(EPOCH FROM ts)::bigint AS ts "
        f"FROM events WHERE token_address IN ({placeholders}) AND ts IS NOT NULL "
        f"ORDER BY token_address, ts ASC, block_number ASC, log_index ASC",
        tuple(addrs),
    )
    out: dict[str, list[tuple[int, float]]] = {}
    for r in rows:
        token = r["token_address"].strip()
        price = market_price(r["side"], int(r["base_value"]), int(r["fee"]), int(r["token_value"]))
        out.setdefault(token, []).append((int(r["ts"]), price))
    return out


class HistoricalPrices:
    """In-memory historical price resolver, semantically identical to
    :func:`price_at_pitch` but without a DB round-trip per lookup.

    Build it once from :func:`load_price_timelines` (the timelines) plus a
    ``current_pitch_fallback`` map (``token_address → current PITCH price`` in
    display units, typically ``market_state.price_pitch / 1e18``) which mirrors
    :func:`_current_price_pitch_fallback`'s last-ditch behaviour. Then call
    :meth:`price_at_pitch` per ``(token, ts)`` — the ``valueSeries`` loop in
    ``app/routes/profile.py`` does this O(events * held-tokens) times, which is
    why the per-call SQL version was the audit's headline N*M round-trip.
    """

    def __init__(
        self,
        timelines: dict[str, list[tuple[int, float]]],
        current_pitch_fallback: dict[str, float],
    ) -> None:
        self._timelines = timelines
        # Parallel arrays of just the timestamps, for bisect.
        self._ts_index: dict[str, list[int]] = {
            tok: [ts for ts, _p in tl] for tok, tl in timelines.items()
        }
        self._fallback = current_pitch_fallback

    def _native_at(self, token: str, ts: int) -> float | None:
        """Native price at ``ts``: the latest sample with ``sample_ts <= ts``
        (step function); the earliest sample when ``ts`` precedes every trade;
        ``None`` when the token has no timeline at all.

        Folds the per-call ``_nearest`` → ``_earliest`` fallback chain into one
        binary search (``bisect_right - 1``): a result ``< 0`` means every
        sample is newer than ``ts`` → return the earliest.
        """

        tl = self._timelines.get(token)
        if not tl:
            return None
        idx = bisect.bisect_right(self._ts_index[token], ts) - 1
        if idx < 0:
            return tl[0][1]
        return tl[idx][1]

    def price_at_pitch(
        self,
        token_address: str,
        kind: str,
        country_address: str | None,
        ts: int,
    ) -> float:
        """Historical PITCH price of ``token_address`` at ``ts`` — same contract
        as the module-level :func:`price_at_pitch`."""

        base_price = self._native_at(token_address, ts)
        if base_price is None or base_price <= 0:
            return self._fallback.get(token_address, 0.0)

        if kind == "country":
            return base_price

        if not country_address:
            return 0.0
        country_pitch = self._native_at(country_address, ts)
        if country_pitch is None or country_pitch <= 0:
            country_pitch = self._fallback.get(country_address, 0.0)
        return current_price_of(base_price, country_pitch)


__all__ = [
    "HistoricalPrices",
    "current_price_of",
    "load_price_timelines",
    "market_price",
    "price_at_pitch",
    "to_display_units",
]
