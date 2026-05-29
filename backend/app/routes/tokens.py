"""``/api/v1/tokens`` family — list + chart + trades.

Per docs/api-spec.md §4:

* ``GET /api/v1/tokens`` (§4.1) — full lists of players & countries with current
  market state + ``lastUpdate`` + ``stale`` flag. 48 countries + 144 players.
* ``GET /api/v1/tokens/{token}/chart?tf=5m`` (§4.2) — both ``candles`` and
  ``points`` in the same response, plus token metadata (``kind``, ``name``,
  ``symbol``, ``country``).
* ``GET /api/v1/tokens/{token}/trades?limit=100&cursor=...`` (§4.3) — paginated
  ``trades`` (with the inner ``{items, nextCursor, limit}`` envelope from §1.5),
  aggregated ``wallets`` per-token, ``totalTrades`` count, and the premium
  ``myWallet`` block (stubbed as ``{"configured": false}`` until B0.11).

Address normalization: the ``{token}`` path parameter is lowercased before any
DB query. Unknown tokens → 404 ``tokens.unknown`` in problem+json.
"""

from __future__ import annotations

import bisect
import re
import time
from typing import Any

from flask import Blueprint, jsonify, request

from app.errors import abort_with_problem
from app.pagination import clamp_limit, decode_cursor, encode_cursor
from shared.chart import TF_SECONDS, build_candles
from shared.db import fetch_all, fetch_one
from shared.log import get_logger
from shared.price import market_price, to_display_units

log = get_logger("app.tokens")

bp = Blueprint("tokens", __name__)

_ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")
_VALID_TFS = frozenset(TF_SECONDS.keys())  # spec §4.2: 1m|5m|15m|1h|4h|1d


def _normalize_token_or_404(raw: str) -> dict[str, Any]:
    """Lowercase ``raw``, validate format, return the matching ``tokens`` row.

    The full row (address, name, symbol, kind, country_address, role) is
    returned so chart/trades handlers can build their metadata blocks without
    a second SELECT.
    """

    if not isinstance(raw, str):
        abort_with_problem(code="tokens.unknown", title="Unknown token", status=404)
    addr = raw.lower()
    if not _ADDR_RE.match(addr):
        abort_with_problem(
            code="tokens.unknown",
            title="Unknown token",
            status=404,
            detail="not a valid 0x-address",
        )
    row = fetch_one(
        "SELECT address, name, symbol, kind, country_address, role, is_icon "
        "FROM tokens WHERE address = %s",
        (addr,),
    )
    if row is None:
        abort_with_problem(code="tokens.unknown", title="Unknown token", status=404)
        raise AssertionError("unreachable")  # mypy / runtime guard
    out = dict(row)
    out["address"] = out["address"].strip()
    if out.get("country_address"):
        out["country_address"] = out["country_address"].strip()
    return out


def _market_row_or_default(token: str) -> dict[str, Any]:
    """Read ``market_state`` for ``token``; return zero-filled defaults if missing.

    ``ask_quote_per_base`` / ``bid_quote_per_base`` (added in migration
    0002) are NULL until the price-loop has populated them at least once.
    They are exposed only for the frontend fee-breakdown UI (and the SSE
    prices channel) — keeper trigger evaluation NEVER uses them.
    """

    row = fetch_one(
        "SELECT price_country, price_pitch, supply, change_pct_all, "
        "change_pct_1d, change_pct_12h, change_pct_6h, change_pct_1h, change_pct_15m, "
        "trades_count, holders_count, "
        "ask_quote_per_base, bid_quote_per_base, "
        "EXTRACT(EPOCH FROM updated_at)::bigint AS updated_at_ts "
        "FROM market_state WHERE token_address = %s",
        (token,),
    )
    if row is None:
        return {
            "price_country": 0,
            "price_pitch": 0,
            "supply": 0,
            "change_pct_all": 0.0,
            "change_pct_1d": 0.0,
            "change_pct_12h": 0.0,
            "change_pct_6h": 0.0,
            "change_pct_1h": 0.0,
            "change_pct_15m": 0.0,
            "trades_count": 0,
            "holders_count": 0,
            "ask_quote_per_base": None,
            "bid_quote_per_base": None,
            "updated_at_ts": None,
        }
    return dict(row)


def _country_name_map() -> dict[str, str]:
    """Build a one-call ``country_address → name`` map for player serialization."""

    rows = fetch_all("SELECT address, name FROM tokens WHERE kind = 'country'")
    return {r["address"].strip(): r["name"] for r in rows}


def _serialize_token(
    row: dict[str, Any],
    market: dict[str, Any],
    country_names: dict[str, str],
) -> dict[str, Any]:
    """Build a single token entry for the ``/tokens`` response (spec §4.1)."""

    # Directional quotes are wei-strings (NULL when worker hasn't populated
    # them yet) so the frontend never loses precision converting from float.
    ask_wei = market.get("ask_quote_per_base")
    bid_wei = market.get("bid_quote_per_base")
    base: dict[str, Any] = {
        "address": row["address"],
        "name": row["name"],
        "symbol": row["symbol"],
        "pricePitch": float(market["price_pitch"]) / 1e18,
        "askPrice": str(int(ask_wei)) if ask_wei is not None else None,
        "bidPrice": str(int(bid_wei)) if bid_wei is not None else None,
        "supply": str(int(market["supply"])),
        "tradesCount": int(market["trades_count"]),
        "holdersCount": int(market["holders_count"]),
        "changePct": {
            "all": float(market["change_pct_all"]),
            "1d": float(market["change_pct_1d"]),
            "12h": float(market["change_pct_12h"]),
            "6h": float(market["change_pct_6h"]),
            "1h": float(market["change_pct_1h"]),
            "15m": float(market["change_pct_15m"]),
        },
    }
    if row["kind"] == "player":
        country_addr = row.get("country_address") or ""
        # Spec §4.1: `country` is the country NAME, `countryAddress` is the
        # address. Both fields are required for players.
        base["country"] = country_names.get(country_addr, "")
        base["countryAddress"] = country_addr
        base["role"] = row["role"]
        base["priceCountry"] = float(market["price_country"]) / 1e18
        # Icon-pack token: trades like a player but on the separate IconCurveHook
        # / router / executor. The frontend reads this to pick the icon venue.
        if row.get("is_icon"):
            base["isIcon"] = True
    return base


@bp.get("/api/v1/tokens")
def list_tokens() -> Any:
    """Full list of players & countries with current market data (spec §4.1)."""

    from shared.config import config as cfg

    # Known-issue #7: tokens must be returned sorted by current PITCH price DESC
    # (most expensive first). LEFT JOIN to `market_state` because new tokens
    # may not yet have a row (worker hasn't backfilled). `NULLS LAST` puts
    # un-priced/zero-priced tokens after priced ones; `address ASC` is the
    # stable tiebreaker so the order doesn't shuffle between requests when
    # several tokens share the same price (very common when everything is 0).
    token_rows = fetch_all(
        "SELECT t.address, t.name, t.symbol, t.kind, t.country_address, t.role, t.is_icon "
        "FROM tokens t "
        "LEFT JOIN market_state m ON m.token_address = t.address "
        "ORDER BY m.price_pitch DESC NULLS LAST, t.address ASC"
    )
    country_names = _country_name_map()

    players: list[dict[str, Any]] = []
    countries: list[dict[str, Any]] = []
    latest_update: int | None = None

    for row in token_rows:
        addr = row["address"].strip()
        market = _market_row_or_default(addr)
        if market["updated_at_ts"] is not None:
            ts = int(market["updated_at_ts"])
            if latest_update is None or ts > latest_update:
                latest_update = ts
        serialized = _serialize_token(row, market, country_names)
        if row["kind"] == "player":
            players.append(serialized)
        else:
            countries.append(serialized)

    now_ts = int(time.time())
    fresh_sec = (now_ts - latest_update) if latest_update is not None else None
    threshold = int(getattr(cfg, "freshness_threshold_sec", 30))
    stale = fresh_sec is None or fresh_sec >= threshold

    return jsonify(
        {
            "players": players,
            "countries": countries,
            "lastUpdate": latest_update,
            "stale": stale,
        }
    )


# Short-lived in-process cache for the chart event history (events audit P3).
# ``GET /chart`` is public, unauthenticated, and re-reads a token's *entire*
# event history on every call (twice for player tokens — the token + its
# country), with no upper bound. New trades land at most once per keeper tick
# (~5s), so a few seconds of staleness is acceptable and collapses bursts of
# chart requests (tf/unit variants, multiple concurrent viewers) onto one read.
# Keyed by token address → (loaded_at_monotonic_seconds, rows). Bounded by the
# token count (~192). Callers must treat the returned list as read-only — the
# chart pipeline does (``build_candles`` / ``_build_chart_points`` read only;
# ``_scale_events_to_pitch`` copies each dict before mutating).
_CHART_EVENTS_TTL_SEC = 5.0
_chart_events_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def _load_events_for_chart(token: str) -> list[dict[str, Any]]:
    """Read every event for ``token`` ordered ASC by (block, log_index).

    Returns rows shaped like :class:`shared.types.Event` (snake_case keys,
    integer wei amounts, ``timestamp`` as unix-seconds). Results are cached
    in-process for :data:`_CHART_EVENTS_TTL_SEC` seconds — see the cache
    comment above. The returned list is shared; callers must not mutate it.
    """

    now = time.monotonic()
    cached = _chart_events_cache.get(token)
    if cached is not None and now - cached[0] < _CHART_EVENTS_TTL_SEC:
        return cached[1]

    rows = fetch_all(
        "SELECT block_number, tx_hash, log_index, token_address, side, "
        "trader_address, base_value, token_value, fee, "
        "EXTRACT(EPOCH FROM ts)::bigint AS timestamp "
        "FROM events WHERE token_address = %s "
        "ORDER BY block_number ASC, log_index ASC",
        (token,),
    )
    # Cast NUMERIC(78,0) to int so shared.chart.market_price gets the right type.
    for r in rows:
        r["base_value"] = int(r["base_value"])
        r["token_value"] = int(r["token_value"])
        r["fee"] = int(r["fee"])
    _chart_events_cache[token] = (now, rows)
    return rows


def _build_country_pitch_timeline(
    country_events: list[dict[str, Any]],
) -> list[tuple[int, float]]:
    """Build a sorted ``[(timestamp, pitch_per_country), ...]`` list from country events.

    For country tokens ``base_value`` is denominated in PITCH, so
    ``market_price(...)`` is exactly the PITCH-per-country price at that trade.
    The list is sorted ASC by ``(timestamp, block_number, log_index)`` so a
    binary search can resolve «latest known price at time T».
    """

    pairs: list[tuple[int, int, int, float]] = []
    for ev in country_events:
        if ev["token_value"] <= 0:
            continue
        price = market_price(ev["side"], ev["base_value"], ev["fee"], ev["token_value"])
        if price <= 0:
            continue
        pairs.append(
            (
                int(ev["timestamp"]),
                int(ev["block_number"]),
                int(ev["log_index"]),
                price,
            )
        )
    pairs.sort(key=lambda x: (x[0], x[1], x[2]))
    return [(ts, price) for ts, _b, _li, price in pairs]


def _pitch_per_country_at(timeline: list[tuple[int, float]], ts: int | float) -> float | None:
    """Return the country→PITCH price at ``ts`` (last sample with ``sample_ts <= ts``).

    Returns ``None`` if ``timeline`` is empty or every sample is strictly newer
    than ``ts`` (no price data yet — caller skips the candle/point).
    """

    if not timeline:
        return None
    target = int(ts)
    timestamps = [t for t, _p in timeline]
    # bisect_right gives the insertion point after equal entries — subtracting 1
    # yields the index of the latest sample with sample_ts <= target.
    idx = bisect.bisect_right(timestamps, target) - 1
    if idx < 0:
        return None
    return timeline[idx][1]


def _build_chart_points(
    events: list[dict[str, Any]],
    *,
    convert_to_pitch: bool = False,
    country_timeline: list[tuple[int, float]] | None = None,
) -> list[dict[str, Any]]:
    """Build the ``points`` array per spec §4.2 — per-trade with type+volume+trader.

    If ``convert_to_pitch`` is True the per-event price (in country units) is
    multiplied by the contemporaneous country→PITCH price from
    ``country_timeline``. Points without an available country price at that
    timestamp are skipped.
    """

    out: list[dict[str, Any]] = []
    # Sort by (block_number ASC, log_index ASC) — same ordering as build_points
    # uses, but we need richer fields than `{time, value}`.
    sorted_evs = sorted(events, key=lambda e: (e["block_number"], e["log_index"]))
    for ev in sorted_evs:
        if ev["token_value"] <= 0:
            continue
        price = market_price(ev["side"], ev["base_value"], ev["fee"], ev["token_value"])
        if price <= 0:
            continue
        if convert_to_pitch:
            timeline = country_timeline or []
            ratio = _pitch_per_country_at(timeline, ev["timestamp"])
            if ratio is None or ratio <= 0:
                # No country price known yet at this timestamp — skip the point.
                continue
            price = price * ratio
        # Sub-second tick offset disambiguates trades sharing a block timestamp
        # (lightweight-charts crashes on duplicate `time` — see shared/chart.py).
        tick_offset = int(ev["log_index"]) * 0.001
        out.append(
            {
                "time": int(ev["timestamp"]) + tick_offset,
                "price": round(price, 6),
                "volume": round(to_display_units(int(ev["token_value"])), 4),
                "type": ev["side"],
                "trader": ev["trader_address"].strip(),
            }
        )
    return out


def _scale_events_to_pitch(
    events: list[dict[str, Any]],
    country_timeline: list[tuple[int, float]],
) -> list[dict[str, Any]]:
    """Return new event dicts with ``base_value``/``fee`` scaled by the country→PITCH
    ratio at **each event's own** timestamp.

    Pre-converting per-event (instead of post-converting bucketed candles) is the
    only correct way to honour intra-bucket country price moves: a 5m candle's
    ``time`` is its bucket-start, which can be earlier than a trade that
    happened inside the bucket — a post-conversion pass would pick the stale
    pre-bucket ratio for events that actually came after a country trade in the
    same 5m window. See ``TestChartUnit::test_unit_pitch_for_player_converts_via_country_price``.

    Events with no ratio available at ``ev["timestamp"]`` (i.e. the player
    traded before any country trade existed) are dropped — downstream
    ``build_candles`` then natively yields PITCH-denominated OHLC. Scaling
    multiplies the wei integer ``base_value`` and ``fee`` by the float ratio:
    ``market_price`` is ``(base ± fee) / token_value`` so this scales the
    resulting price exactly. ``token_value`` is left untouched so candle
    volumes (in token units) are unchanged.
    """

    out: list[dict[str, Any]] = []
    for ev in events:
        ratio = _pitch_per_country_at(country_timeline, ev["timestamp"])
        if ratio is None or ratio <= 0:
            continue
        scaled = dict(ev)
        # Use int(round(...)) to keep the field type consistent with how the
        # rest of the module treats `base_value` / `fee` (int wei). The float
        # precision loss is negligible vs. 18-decimal wei values.
        scaled["base_value"] = int(round(int(ev["base_value"]) * ratio))
        scaled["fee"] = int(round(int(ev["fee"]) * ratio))
        out.append(scaled)
    return out


def _log_chart_mid_sanity(
    token: str,
    events: list[dict[str, Any]],
    market: dict[str, Any],
    unit: str,
) -> None:
    """Sanity-check: last event's MID-derived price ≈ market_state.price_*.

    ``shared.price.market_price`` already produces fee-free MID prices from
    ``base_value`` / ``fee`` / ``token_value`` — the chart pipeline is
    therefore MID-aligned with ``Hook.currentPrice`` (which is what
    ``market_state.price_country`` / ``price_pitch`` cache). This helper
    logs a comparison the first time a token's chart is requested so a
    regression in the math is visible in logs.

    The comparison is done at the chart endpoint level (not at every
    candle build) to keep overhead bounded — one fetch_one's worth of work
    per request, and only when there's at least one event.
    """

    if not events:
        return
    # Only compare for the unit that matches the market_state column.
    # 'country' unit ⇔ price_country (player venue native); 'pitch' for
    # countries collapses onto price_pitch.
    last = events[-1]
    side = last["side"]
    base_value = int(last["base_value"])
    fee_value = int(last["fee"])
    token_value = int(last["token_value"])
    if token_value <= 0:
        return
    last_mid_display = market_price(side, base_value, fee_value, token_value)
    if last_mid_display <= 0:
        return

    if unit == "country":
        cached_wei = int(market.get("price_country") or 0)
    else:
        cached_wei = int(market.get("price_pitch") or 0)
    if cached_wei <= 0:
        return
    cached_display = cached_wei / 1e18

    # Allow ~1% drift between the last event's MID and the cached
    # Hook.currentPrice — price impact of the last trade itself easily
    # accounts for sub-1% gaps; anything bigger is worth a warning.
    drift = abs(last_mid_display - cached_display) / cached_display
    if drift > 0.01:
        log.warning(
            "chart.mid_drift",
            token=token,
            unit=unit,
            last_event_mid=round(last_mid_display, 8),
            cached_mid=round(cached_display, 8),
            drift_pct=round(drift * 100, 3),
        )
    else:
        log.debug(
            "chart.mid_ok",
            token=token,
            unit=unit,
            last_event_mid=round(last_mid_display, 8),
            cached_mid=round(cached_display, 8),
            drift_pct=round(drift * 100, 3),
        )


def _append_spot_point(
    points: list[dict[str, Any]],
    market: dict[str, Any],
    *,
    unit: str = "pitch",
) -> list[dict[str, Any]]:
    """Append a synthetic `spot` point at ``now`` carrying the latest price.

    For player tokens the «country» unit needs ``price_country`` (denominated
    in the parent country token); for everything else (countries, or
    ``unit="pitch"``) we use ``price_pitch``.
    """

    if unit == "country":
        spot_price = float(market.get("price_country", 0)) / 1e18
    else:
        spot_price = float(market.get("price_pitch", 0)) / 1e18
    if spot_price <= 0:
        return points
    # Place spot strictly after the last trade time so the chart series stays
    # monotonic; default to ``now`` if no prior trades.
    base_time = points[-1]["time"] if points else int(time.time())
    return [
        *points,
        {
            "time": float(base_time) + 0.999,
            "price": round(spot_price, 6),
            "volume": 0.0,
            "type": "spot",
            "trader": "",
        },
    ]


@bp.get("/api/v1/tokens/<token>/chart")
def get_chart(token: str) -> Any:
    """Candles + line points for ``token`` at the requested timeframe (spec §4.2).

    Query ``unit`` selects the price denomination:

    * ``pitch`` (default) — all OHLC values + spot point in PITCH. Player
      candles are converted from native country units using the historical
      ``country → PITCH`` price at each candle's timestamp.
    * ``country`` — for player tokens, OHLC stays in the parent-country units
      (this is the contract-native denomination — no conversion). For country
      tokens the value is identical to ``pitch`` (countries trade against
      PITCH directly).

    **Price space:** every value returned by this endpoint — historical
    candles, line points, and the synthetic spot tick — is the fee-free
    **MID** price (what the bonding curve calls ``currentPrice``). The
    conversion happens in :func:`shared.price.market_price`, which already
    extracts MID from each event's ``base_value`` / ``fee`` /
    ``token_value`` (``(base - fee) / token`` for buys; ``(base + fee) /
    token`` for sells). The spot tick comes from
    ``market_state.price_country`` / ``price_pitch`` which are populated
    from ``Hook.currentPrice`` — also MID. So the chart axis is in a
    single, consistent denomination; the per-trade ASK/BID rates from the
    trade table are NOT used here. See :mod:`shared.fee` for the
    user-facing ASK/BID story.
    """

    row = _normalize_token_or_404(token)
    addr = row["address"]

    tf = request.args.get("tf", "5m")
    if tf not in _VALID_TFS:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad timeframe",
            status=400,
            detail=f"tf must be one of: {','.join(sorted(TF_SECONDS.keys()))}",
        )

    unit = request.args.get("unit", "pitch")
    if unit not in ("pitch", "country"):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad unit",
            status=400,
            detail="unit must be 'pitch' or 'country'",
        )

    events = _load_events_for_chart(addr)

    # `unit=pitch` for player tokens requires multiplying every event's price
    # by the contemporaneous country→PITCH price BEFORE bucketing — see
    # `_scale_events_to_pitch` docstring. Country tokens are already
    # PITCH-denominated so no conversion is ever required.
    needs_conversion = row["kind"] == "player" and unit == "pitch"
    country_timeline: list[tuple[int, float]] = []
    chart_events = events
    if needs_conversion:
        country_addr = row.get("country_address") or ""
        if not country_addr:
            abort_with_problem(
                code="validation.bad_request",
                title="No country market",
                status=400,
                detail="player token has no country_address; cannot convert to PITCH",
            )
        country_events = _load_events_for_chart(country_addr)
        country_timeline = _build_country_pitch_timeline(country_events)
        chart_events = _scale_events_to_pitch(events, country_timeline)

    candles = build_candles(chart_events, TF_SECONDS[tf])  # type: ignore[arg-type]
    # `_build_chart_points` still needs the original (unscaled) events + the
    # country timeline because it converts per-event itself (and reports the
    # untouched `volume` derived from `token_value`).
    points = _build_chart_points(
        events,
        convert_to_pitch=needs_conversion,
        country_timeline=country_timeline,
    )

    market = _market_row_or_default(addr)
    # Spot point follows the requested unit. For country tokens both units
    # collapse to the same column (price_pitch), so pass "pitch" regardless.
    spot_unit = "country" if (row["kind"] == "player" and unit == "country") else "pitch"
    points = _append_spot_point(points, market, unit=spot_unit)

    # MID-alignment sanity log — see ``_log_chart_mid_sanity``. Comparing
    # the country-unit MID against the cached price_country only makes
    # sense for ``unit=country`` (player venue) or for country tokens.
    # For ``unit=pitch`` on a player token we've already multiplied by
    # the country→PITCH ratio so the comparison is apples-to-apples
    # against ``price_pitch``.
    sanity_unit = "country" if (row["kind"] == "player" and unit == "country") else "pitch"
    sanity_events = chart_events if needs_conversion else events
    _log_chart_mid_sanity(addr, sanity_events, market, sanity_unit)

    country_names = _country_name_map()
    country_name = ""
    if row["kind"] == "player" and row.get("country_address"):
        country_name = country_names.get(row["country_address"], "")

    return jsonify(
        {
            "kind": row["kind"],
            "name": row["name"],
            "symbol": row["symbol"],
            "country": country_name,
            "unit": unit,
            "candles": candles,
            "points": points,
        }
    )


def _serialize_trade(row: dict[str, Any]) -> dict[str, Any]:
    """Build a single trade entry per spec §4.3 (premium-stripped: no walletPosition)."""

    side = row["side"]
    base = int(row["base_value"])
    tokens = int(row["token_value"])
    fee = int(row["fee"])
    effective_price = (base / tokens) if tokens > 0 else 0.0
    return {
        "type": side,
        "trader": row["trader_address"].strip(),
        "baseValue": round(to_display_units(base), 4),
        "tokenValue": round(to_display_units(tokens), 4),
        "price": round(effective_price, 6),
        "marketPrice": round(market_price(side, base, fee, tokens), 6),
        "fee": round(to_display_units(fee), 6),
        "tx": row["tx_hash"].strip(),
        "timestamp": int(row["timestamp"]),
        # `walletPosition` / `walletBuys` / `walletSells` are non-premium-stripped
        # — premium gating in B0.11 will populate them when the requester has
        # access. Keep them present as null/0 so the JSON shape stays stable.
        "walletPosition": None,
        "walletBuys": 0,
        "walletSells": 0,
    }


def _aggregate_wallets(token: str) -> list[dict[str, Any]]:
    """Return per-trader aggregates for ``token`` (spec §4.3 ``wallets`` array)."""

    rows = fetch_all(
        "SELECT trader_address, "
        "SUM(CASE WHEN side='buy' THEN 1 ELSE 0 END) AS buys, "
        "SUM(CASE WHEN side='sell' THEN 1 ELSE 0 END) AS sells, "
        "SUM(CASE WHEN side='buy' THEN token_value::numeric ELSE -token_value::numeric END) AS net_tokens, "
        "SUM(CASE WHEN side='buy' THEN base_value::numeric ELSE 0 END) AS spent, "
        "SUM(CASE WHEN side='sell' THEN base_value::numeric ELSE 0 END) AS received, "
        "SUM(CASE WHEN side='buy' THEN token_value::numeric ELSE 0 END) AS bought "
        "FROM events WHERE token_address = %s "
        "GROUP BY trader_address "
        "HAVING SUM(CASE WHEN side='buy' THEN token_value::numeric "
        "                ELSE -token_value::numeric END) > 0 "
        "ORDER BY net_tokens DESC",
        (token,),
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        position = to_display_units(int(r["net_tokens"]))
        spent = to_display_units(int(r["spent"]))
        received = to_display_units(int(r["received"]))
        bought = to_display_units(int(r["bought"]))
        avg_buy = (spent / bought) if bought > 0 else 0.0
        avg_net = ((spent - received) / position) if position > 0 else 0.0
        out.append(
            {
                "address": r["trader_address"].strip(),
                "buys": int(r["buys"]),
                "sells": int(r["sells"]),
                "position": round(position, 4),
                "spent": round(spent, 4),
                "received": round(received, 4),
                "avgBuy": round(avg_buy, 6),
                "avgNet": round(max(avg_net, 0.0), 6),
            }
        )
    return out


@bp.get("/api/v1/tokens/<token>/trades")
def get_trades(token: str) -> Any:
    """Recent trades + per-wallet aggregates + total count (spec §4.3)."""

    row = _normalize_token_or_404(token)
    addr = row["address"]

    limit = clamp_limit(request.args.get("limit"))
    cursor_raw = request.args.get("cursor")

    where_extra = ""
    params: list[Any] = [addr]
    if cursor_raw:
        cursor = decode_cursor(cursor_raw)
        try:
            b = int(cursor["b"])
            li = int(cursor["l"])
        except (KeyError, TypeError, ValueError) as err:
            abort_with_problem(
                code="validation.bad_request",
                title="Bad cursor",
                status=400,
                detail='cursor must carry {"b": int, "l": int}',
            )
            raise AssertionError("unreachable") from err
        where_extra = " AND (block_number < %s OR (block_number = %s AND log_index < %s))"
        params.extend([b, b, li])

    # Fetch limit+1 to detect a next page without a separate count query.
    params.append(limit + 1)
    rows = fetch_all(
        "SELECT block_number, tx_hash, log_index, token_address, side, "
        "trader_address, base_value, token_value, fee, "
        "EXTRACT(EPOCH FROM ts)::bigint AS timestamp "
        "FROM events WHERE token_address = %s" + where_extra + " "
        "ORDER BY block_number DESC, log_index DESC LIMIT %s",
        tuple(params),
    )

    next_cursor: str | None = None
    if len(rows) > limit:
        rows = rows[:limit]
        last = rows[-1]
        next_cursor = encode_cursor({"b": int(last["block_number"]), "l": int(last["log_index"])})

    items = [_serialize_trade(r) for r in rows]

    # ``totalTrades`` reuses the worker-maintained ``market_state.trades_count``
    # (refreshed every price tick) instead of a per-request ``COUNT(*)`` over the
    # hot ``events`` table — it's the same number, kept fresh out-of-band. Falls
    # back to 0 for tokens the price loop hasn't populated yet (no events ⇒ 0).
    market_row = fetch_one(
        "SELECT trades_count FROM market_state WHERE token_address = %s", (addr,)
    )
    total_trades = int(market_row["trades_count"]) if market_row else 0

    wallets = _aggregate_wallets(addr)

    return jsonify(
        {
            "trades": {
                "items": items,
                "nextCursor": next_cursor,
                "limit": limit,
            },
            "wallets": wallets,
            "totalTrades": total_trades,
            "myWallet": {"configured": False},
        }
    )


__all__ = ["bp"]
