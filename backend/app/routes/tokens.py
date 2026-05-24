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

import re
import time
from typing import Any

from flask import Blueprint, jsonify, request

from app.errors import abort_with_problem
from app.pagination import clamp_limit, decode_cursor, encode_cursor
from shared.chart import TF_SECONDS, build_candles
from shared.db import fetch_all, fetch_one
from shared.price import market_price, to_display_units

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
        "SELECT address, name, symbol, kind, country_address, role "
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
    """Read ``market_state`` for ``token``; return zero-filled defaults if missing."""

    row = fetch_one(
        "SELECT price_country, price_pitch, supply, change_pct_all, "
        "change_pct_1d, change_pct_12h, change_pct_6h, change_pct_1h, change_pct_15m, "
        "trades_count, holders_count, "
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

    base: dict[str, Any] = {
        "address": row["address"],
        "name": row["name"],
        "symbol": row["symbol"],
        "pricePitch": float(market["price_pitch"]) / 1e18,
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
    return base


@bp.get("/api/v1/tokens")
def list_tokens() -> Any:
    """Full list of players & countries with current market data (spec §4.1)."""

    from shared.config import config as cfg

    token_rows = fetch_all("SELECT address, name, symbol, kind, country_address, role FROM tokens")
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


def _load_events_for_chart(token: str) -> list[dict[str, Any]]:
    """Read every event for ``token`` ordered ASC by (block, log_index).

    Returns rows shaped like :class:`shared.types.Event` (snake_case keys,
    integer wei amounts, ``timestamp`` as unix-seconds).
    """

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
    return rows


def _build_chart_points(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Build the ``points`` array per spec §4.2 — per-trade with type+volume+trader."""

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


def _append_spot_point(
    points: list[dict[str, Any]], market: dict[str, Any]
) -> list[dict[str, Any]]:
    """Append a synthetic `spot` point at ``now`` carrying the latest price."""

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
    """Candles + line points for ``token`` at the requested timeframe (spec §4.2)."""

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

    events = _load_events_for_chart(addr)
    candles = build_candles(events, TF_SECONDS[tf])  # type: ignore[arg-type]
    points = _build_chart_points(events)

    market = _market_row_or_default(addr)
    points = _append_spot_point(points, market)

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

    total_row = fetch_one("SELECT COUNT(*) AS n FROM events WHERE token_address = %s", (addr,))
    total_trades = int(total_row["n"]) if total_row else 0

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
