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

from flask import Blueprint, g, jsonify

from app.deps import require_premium
from shared.config import WEI
from shared.db import fetch_all

bp = Blueprint("portfolio", __name__)


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
    if bought_wei > 0:
        avg_entry_base_wei = spent_wei * 10**18 // bought_wei  # base-wei per 1.0 token
    else:
        avg_entry_base_wei = 0

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

    return {
        "token": token,
        "symbol": row["symbol"],
        "kind": kind,
        "balance": _wei_str(net_tokens_wei),
        "balanceDisplay": round(_to_float(net_tokens_wei), 4),
        "avgEntryPitch": _wei_str(avg_entry_pitch_wei),
        "currentPricePitch": _wei_str(current_price_pitch_wei),
        "valuePitch": _wei_str(value_pitch_wei),
        "pnlPitch": _wei_str(pnl_pitch_wei),
        # Convenience floats — UI doesn't need to do BigInt math just to render.
        "avgEntryPitchDisplay": round(_to_float(avg_entry_pitch_wei), 6),
        "currentPricePitchDisplay": round(_to_float(current_price_pitch_wei), 6),
        "valuePitchDisplay": round(_to_float(value_pitch_wei), 4),
        "pnlPitchDisplay": round(_to_float(pnl_pitch_wei), 4),
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


__all__ = ["bp"]
