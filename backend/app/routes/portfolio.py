"""``/api/v1/portfolio`` — premium multi-token wallet overview.

Per docs/api-spec.md §6.2. Returns every token (player or country) for which
the authenticated wallet has a non-zero net position, with cost-basis +
current-price + PnL fields denominated in PITCH.

Differences from :mod:`app.routes.profile` (§6.1):
* This endpoint is intentionally *light* — no trades pagination, no on-chain
  ``balances`` block, no ``valueSeries``. Frontend uses it to drive the
  "My Wallet" table in the bottom block and the player-dots overlay in the
  sidebar; both consumers want the positions list and nothing else.
* All wei-valued fields ship as decimal strings (``"1234..."``) per api-spec
  §1.2 — no precision loss on large balances. Float ``balanceDisplay`` is an
  ergonomic helper for table cells (matches the precision of other display
  fields in the spec).

Data source: aggregated over ``events`` (sum of buys minus sells per token).
There is no ``wallets`` / ``positions`` table — the events table is the
source of truth (see :mod:`shared.pnl`).
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from flask import Blueprint, g, jsonify, request

from app.deps import require_premium
from app.errors import abort_with_problem
from app.pagination import decode_cursor, encode_cursor
from app.routes.profile import _build_trade_item, _load_token_meta
from shared.config import WEI
from shared.db import fetch_all, fetch_one
from shared.types import Event

bp = Blueprint("portfolio", __name__)

# Per-token trades pagination: spec §6.x. Default 50, capped at 100 so the
# frontend's "trade history per token" list can page sensibly without ever
# pulling an unbounded window.
_TRADES_DEFAULT_LIMIT = 50
_TRADES_MAX_LIMIT = 100
_ADDR_RE_LEN = 42


def _load_positions(wallet: str) -> list[dict[str, Any]]:
    """Aggregate ``events`` for ``wallet`` into per-token positions.

    Returns one row per token with a non-zero net wei position. Cost basis,
    received, gross-bought, and fees are all wei integers (NUMERIC(78,0)).

    Why SQL aggregation vs Python: the per-token rollup is exactly what
    Postgres does best, and we skip loading the full event list into the API
    process. Heavy traders may have thousands of events; one round-trip beats
    streaming them all.
    """

    rows = fetch_all(
        """
        SELECT
          e.token_address,
          SUM(CASE WHEN e.side='buy'  THEN e.token_value::numeric
                   ELSE -e.token_value::numeric END) AS net_tokens_wei,
          SUM(CASE WHEN e.side='buy'  THEN e.token_value::numeric ELSE 0 END)
            AS bought_wei,
          SUM(CASE WHEN e.side='buy'  THEN e.base_value::numeric  ELSE 0 END)
            AS spent_wei,
          SUM(CASE WHEN e.side='sell' THEN e.base_value::numeric  ELSE 0 END)
            AS received_wei,
          SUM(e.fee::numeric) AS fees_wei,
          t.symbol,
          t.kind,
          t.country_address,
          COALESCE(m.price_pitch, 0) AS price_pitch_wei
        FROM events e
        JOIN tokens t        ON t.address = e.token_address
        LEFT JOIN market_state m ON m.token_address = e.token_address
        WHERE e.trader_address = %s
        GROUP BY e.token_address, t.symbol, t.kind, t.country_address,
                 m.price_pitch
        HAVING SUM(CASE WHEN e.side='buy' THEN e.token_value::numeric
                        ELSE -e.token_value::numeric END) > 0
        ORDER BY e.token_address
        """,
        (wallet,),
    )
    return rows


def _country_pitch_prices(country_addrs: set[str]) -> dict[str, int]:
    """Return ``{country_address → price_pitch_wei}`` for the given countries.

    Used to convert player positions' base-denominated cost basis into PITCH.
    A missing entry (country never had its own price recorded) maps to ``0`` —
    callers must treat that as «PnL not computable» and fall back gracefully.
    """

    if not country_addrs:
        return {}
    addr_list = sorted(country_addrs)
    placeholders = ",".join(["%s"] * len(addr_list))
    rows = fetch_all(
        f"SELECT token_address, price_pitch FROM market_state "
        f"WHERE token_address IN ({placeholders})",
        tuple(addr_list),
    )
    return {r["token_address"].strip(): int(r["price_pitch"]) for r in rows}


def _wei_str(value: int | Decimal) -> str:
    """Format a wei integer as a decimal string per api-spec §1.2."""

    return str(int(value))


def _to_float(wei_value: int | Decimal) -> float:
    """Divide a wei integer by 1e18 with Decimal precision before float-cast."""

    return float(Decimal(int(wei_value)) / Decimal(WEI))


def _build_item(row: dict[str, Any], country_prices_wei: dict[str, int]) -> dict[str, Any]:
    """Translate one aggregation row into the response shape.

    All wei-string fields are computed from NUMERIC(78,0) sums so they stay
    exact. Float fields are derived from the wei values for UI ergonomics.
    """

    token = row["token_address"].strip()
    kind = row["kind"]
    net_tokens_wei = int(row["net_tokens_wei"])
    bought_wei = int(row["bought_wei"])
    spent_wei = int(row["spent_wei"])  # base-denominated (country for players, PITCH for countries)
    received_wei = int(row["received_wei"])
    fees_wei = int(row["fees_wei"])
    price_pitch_wei = int(row["price_pitch_wei"])

    # ─── Cost basis (avg entry per token, in *base* currency, wei) ──────────
    # spent / bought, integer-divided to stay in wei units. Used for both
    # display and PnL so the two numbers always agree.
    avg_entry_base_wei = spent_wei * 10**18 // bought_wei if bought_wei > 0 else 0

    # ─── Convert base→PITCH for player tokens ───────────────────────────────
    # For players: base = country token; price in PITCH = (base price * country→PITCH).
    # For countries: base = PITCH already; conversion is the identity.
    if kind == "player":
        country_addr = (row["country_address"] or "").strip()
        country_pitch_wei = country_prices_wei.get(country_addr, 0)
        # avg_entry_base_wei is denominated in country-wei per 1.0 token.
        # Multiply by country→PITCH rate to get pitch-wei per 1.0 token.
        # country_pitch_wei = pitch-wei per 1.0 country. Both are 1e18-scaled.
        avg_entry_pitch_wei = (avg_entry_base_wei * country_pitch_wei) // 10**18
        # spot price_pitch is already given by market_state for players
        current_price_pitch_wei = price_pitch_wei
    else:
        # countries: base IS PITCH, so price_country in market_state is 0;
        # avg_entry is already pitch-wei per 1.0 token.
        avg_entry_pitch_wei = avg_entry_base_wei
        current_price_pitch_wei = price_pitch_wei

    # ─── Value + PnL (all in pitch-wei) ─────────────────────────────────────
    # value = position * current_price (both 1e18-scaled → divide by WEI once).
    value_pitch_wei = (net_tokens_wei * current_price_pitch_wei) // 10**18
    cost_basis_pitch_wei = (net_tokens_wei * avg_entry_pitch_wei) // 10**18
    pnl_pitch_wei = value_pitch_wei - cost_basis_pitch_wei  # may be negative

    # ─── Break-even (net cost per held token, *base* currency, wei) ──────────
    # (spent - received) / position — the per-token price at which selling the
    # whole remaining position nets zero total PnL. Floored at 0 (a position
    # that has already returned more than it cost has no positive break-even).
    sold_wei = bought_wei - net_tokens_wei  # gross tokens sold
    break_even_base_wei = (
        max((spent_wei - received_wei) * 10**18 // net_tokens_wei, 0) if net_tokens_wei > 0 else 0
    )

    # ─── Realized PnL (already-locked profit/loss, *base* currency, wei) ─────
    # received - avgBuy * sold. Can be NEGATIVE (sold below cost basis).
    realized_base_wei = received_wei - (avg_entry_base_wei * sold_wei) // 10**18

    # Convert both from base→PITCH. break_even mirrors avg_entry (player: scale by
    # country→PITCH; country: identity). realized needs the same scaling but is
    # sign-sensitive: Python ``//`` floors toward -inf, so a naive
    # ``(neg * rate) // 10**18`` would bias the loss. Split the sign off, scale
    # the magnitude, then re-apply — keeps negative values exact.
    if kind == "player":
        break_even_pitch_wei = (break_even_base_wei * country_pitch_wei) // 10**18
        realized_sign = -1 if realized_base_wei < 0 else 1
        realized_pitch_wei = realized_sign * (
            (abs(realized_base_wei) * country_pitch_wei) // 10**18
        )
    else:
        # countries: base IS PITCH → identity conversion.
        break_even_pitch_wei = break_even_base_wei
        realized_pitch_wei = realized_base_wei

    return {
        "token": token,
        "symbol": row["symbol"],
        "kind": kind,
        "balance": _wei_str(net_tokens_wei),
        "balanceDisplay": round(_to_float(net_tokens_wei), 4),
        "avgEntryPitch": _wei_str(avg_entry_pitch_wei),
        "breakEvenPitch": _wei_str(break_even_pitch_wei),
        # Break-even in *base* (country for players, PITCH for countries) units.
        # The chart's price-denomination toggle picks this when viewing a player
        # token in 'country' mode so the Net-pos line stays in the right units.
        "breakEvenBaseWei": _wei_str(break_even_base_wei),
        "currentPricePitch": _wei_str(current_price_pitch_wei),
        "valuePitch": _wei_str(value_pitch_wei),
        "pnlPitch": _wei_str(pnl_pitch_wei),
        "realizedPitch": _wei_str(realized_pitch_wei),  # may be negative
        # Convenience floats — UI doesn't need to do BigInt math just to render.
        "avgEntryPitchDisplay": round(_to_float(avg_entry_pitch_wei), 6),
        "breakEvenPitchDisplay": round(_to_float(break_even_pitch_wei), 6),
        "breakEvenBaseDisplay": round(_to_float(break_even_base_wei), 6),
        "currentPricePitchDisplay": round(_to_float(current_price_pitch_wei), 6),
        "valuePitchDisplay": round(_to_float(value_pitch_wei), 4),
        "pnlPitchDisplay": round(_to_float(pnl_pitch_wei), 4),
        "realizedPitchDisplay": round(_to_float(realized_pitch_wei), 4),
        # Raw aggregation metadata (helps debugging + future UI needs).
        "feesPaidWei": _wei_str(fees_wei),
        "spentBaseWei": _wei_str(spent_wei),
        "receivedBaseWei": _wei_str(received_wei),
    }


@bp.get("/api/v1/portfolio")
@require_premium
def get_portfolio() -> Any:
    """Return all non-zero positions for the authenticated wallet (spec §6.2).

    Order: by ``valuePitch`` descending (largest holdings first) — same UX as
    the profile.positions block; saves the frontend a sort.
    """

    wallet = g.address  # lowercased by require_auth
    rows = _load_positions(wallet)

    # Pre-fetch country PITCH prices for all player rows in one query.
    country_addrs = {
        (r["country_address"] or "").strip()
        for r in rows
        if r["kind"] == "player" and r["country_address"]
    }
    country_prices_wei = _country_pitch_prices(country_addrs)

    items = [_build_item(r, country_prices_wei) for r in rows]
    # Sort by value descending — wei ints, exact compare.
    items.sort(key=lambda it: -int(it["valuePitch"]))
    return jsonify({"items": items})


# ─── /api/v1/portfolio/trades — per-token wallet trade history ──────────────


def _clamp_trades_limit(value: Any) -> int:
    """Parse & clamp ``?limit=`` to ``[1, _TRADES_MAX_LIMIT]`` (default 50).

    Mirrors :func:`app.pagination.clamp_limit` but with this endpoint's own
    default/maximum (the shared clamp defaults to 100/500, which is too wide
    for a per-token history list).
    """

    if value is None or value == "":
        return _TRADES_DEFAULT_LIMIT
    try:
        n = int(value)
    except (TypeError, ValueError):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad limit",
            status=400,
            detail="limit must be an integer",
        )
        raise  # unreachable
    if n < 1 or n > _TRADES_MAX_LIMIT:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad limit",
            status=400,
            detail=f"limit must be in [1, {_TRADES_MAX_LIMIT}]",
        )
    return n


def _decode_trades_cursor(cursor_raw: str | None) -> tuple[int, int] | None:
    """Decode the optional ``cursor`` into ``(block_number, log_index)``.

    Same opaque ``{"b": int, "l": int}`` payload as profile.trades and the
    per-token tokens/{token}/trades endpoint (api-spec §1.5).
    """

    if not cursor_raw:
        return None
    cursor = decode_cursor(cursor_raw)
    try:
        return int(cursor["b"]), int(cursor["l"])
    except (KeyError, TypeError, ValueError) as err:
        abort_with_problem(
            code="validation.bad_request",
            title="Bad cursor",
            status=400,
            detail='cursor must carry {"b": int, "l": int}',
        )
        raise AssertionError("unreachable") from err


def _token_exists(token: str) -> bool:
    """True when ``token`` is a known row in the ``tokens`` table."""

    return fetch_one("SELECT 1 FROM tokens WHERE address = %s", (token,)) is not None


def _load_wallet_token_trades(
    wallet: str,
    token: str,
    cursor: tuple[int, int] | None,
    limit: int,
) -> tuple[list[Event], str | None]:
    """Fetch one DESC page of ``wallet``'s trades on ``token``.

    Filtered ``WHERE trader_address = %s AND token_address = %s`` and ordered
    ``block_number DESC, log_index DESC`` — the keyset window is applied in SQL
    (``< (cursor_block, cursor_log)`` lexicographically) so we never load the
    full history into the API process. Fetches ``limit + 1`` rows to detect a
    next page, then trims and computes ``nextCursor``.
    """

    params: list[Any] = [wallet, token]
    where_extra = ""
    if cursor is not None:
        b, li = cursor
        # Lexicographic keyset: (block, log) strictly before the cursor.
        where_extra = " AND (block_number < %s OR (block_number = %s AND log_index < %s))"
        params.extend([b, b, li])
    params.append(limit + 1)

    rows = fetch_all(
        "SELECT block_number, tx_hash, log_index, token_address, side, "
        "trader_address, base_value, token_value, fee, "
        "EXTRACT(EPOCH FROM ts)::bigint AS timestamp "
        "FROM events WHERE trader_address = %s AND token_address = %s" + where_extra + " "
        "ORDER BY block_number DESC, log_index DESC LIMIT %s",
        tuple(params),
    )

    events: list[Event] = []
    for r in rows:
        events.append(
            {
                "block_number": int(r["block_number"]),
                "tx_hash": r["tx_hash"].strip(),
                "log_index": int(r["log_index"]),
                "token_address": r["token_address"].strip(),
                "side": r["side"],
                "trader_address": r["trader_address"].strip(),
                "base_value": int(r["base_value"]),
                "token_value": int(r["token_value"]),
                "fee": int(r["fee"]),
                "timestamp": int(r["timestamp"]),
            }
        )

    next_cursor: str | None = None
    if len(events) > limit:
        events = events[:limit]
        last = events[-1]
        next_cursor = encode_cursor({"b": int(last["block_number"]), "l": int(last["log_index"])})
    return events, next_cursor


@bp.get("/api/v1/portfolio/trades")
@require_premium
def get_portfolio_trades() -> Any:
    """Per-token trade history for the authenticated wallet.

    Query params:
        token: required, lowercase 0x address. ``404`` if unknown, ``400`` if
            missing.
        limit: optional, default 50, clamped to ``[1, 100]``.
        cursor: optional opaque ``{"b": block, "l": log_index}`` keyset cursor.

    Response::

        {"items": [ <trade item, profile §6.1 shape> ], "nextCursor": null|str,
         "limit": 50}

    Trade items reuse :func:`app.routes.profile._build_trade_item` so the shape
    is identical to ``GET /api/v1/profile``'s ``trades.items[*]``.
    """

    wallet = g.address  # lowercased by require_auth

    token_raw = request.args.get("token")
    if not token_raw:
        abort_with_problem(
            code="validation.bad_request",
            title="Missing token",
            status=400,
            detail="token query param is required",
        )
        raise AssertionError("unreachable")
    token = token_raw.lower()
    if len(token) != _ADDR_RE_LEN or not token.startswith("0x"):
        abort_with_problem(code="tokens.unknown", title="Unknown token", status=404)
        raise AssertionError("unreachable")
    if not _token_exists(token):
        abort_with_problem(code="tokens.unknown", title="Unknown token", status=404)
        raise AssertionError("unreachable")

    limit = _clamp_trades_limit(request.args.get("limit"))
    cursor = _decode_trades_cursor(request.args.get("cursor"))

    events, next_cursor = _load_wallet_token_trades(wallet, token, cursor, limit)
    meta = _load_token_meta({token}).get(token, {})
    items = [_build_trade_item(ev, meta) for ev in events]

    return jsonify({"items": items, "nextCursor": next_cursor, "limit": limit})


__all__ = ["bp"]
