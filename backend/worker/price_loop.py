"""Per-tick refresh of ``market_state``: prices, supplies, derived stats.

Each tick:

1. Load the token list from the DB (192 rows: 48 countries + 144 players).
2. Build one Multicall3 batch:
   * For every **player** token: ``Hook.currentPrice(player)`` against the
     Player Hook, plus ``totalSupply()`` on the token itself.
   * For every **country** token: ``Hook.currentPrice(country)`` against the
     Country Hook (its price in PITCH), plus ``totalSupply()``.
3. Decode results.
4. Compute derived stats per token using SQL on the ``events`` table —
   ``trades_count``, ``holders_count``, and ``change_pct_*`` for the six
   periods (see ``docs/port-from-portable.md`` §5.1).
5. UPSERT each row in ``market_state``.

Note on selectors and ABI:
We hardcode the 4-byte selectors instead of loading ABI JSON because the
``abis/`` directory is intentionally minimal — the portable repo uses the
same trick (server.py:168). Encoding an address argument is a fixed-shape
pad (no dynamic types), so we can build the calldata by hand without
``eth_abi``.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from web3 import Web3

from shared.config import WEI, config
from shared.db import fetch_all, get_conn
from shared.eth import multicall3_aggregate
from shared.log import get_logger
from shared.notify import notify
from shared.price import market_price
from worker import _w3, operator_alerts

# Cross-tick in-memory snapshot for delta detection. Worker is single-process,
# so a module-level dict is sufficient (and avoids a DB round-trip per tick to
# read the previous values). Keyed by lowercased token address → (price_pitch,
# price_country) wei tuple. On first tick this is empty → every token is
# treated as "changed", which is fine (the first NOTIFY just announces the
# whole snapshot to any subscribers that came in earlier).
_PREV_PRICES: dict[str, tuple[int, int]] = {}

# Wall-clock (unix seconds) of the most recent successful price tick. 0 means
# "never updated"; operator_alerts.record_price_stale ignores 0 to avoid
# alerting on a cold worker. Updated only when we actually wrote market_state.
_LAST_PRICE_UPDATE_TS: float = 0.0

log = get_logger("worker.price_loop")

_PRICE_SEL = Web3.keccak(text="currentPrice(address)")[:4]
_SUPPLY_SEL = bytes.fromhex("18160ddd")  # totalSupply()


# Period definitions for change_pct_* (in seconds). 'all' means «from the very
# first trade ever», represented by a sentinel of None.
_PERIODS: tuple[tuple[str, int | None], ...] = (
    ("all", None),
    ("1d", 24 * 3600),
    ("12h", 12 * 3600),
    ("6h", 6 * 3600),
    ("1h", 1 * 3600),
    ("15m", 15 * 60),
)


def _addr_padded(addr: str) -> bytes:
    """Pad a 20-byte address to a 32-byte ABI slot (right-aligned)."""

    return bytes.fromhex(addr[2:].zfill(64))


def _load_tokens() -> list[dict[str, Any]]:
    """Return rows ``{address, kind, country_address}`` for every token."""

    return fetch_all(
        "SELECT address, kind, country_address FROM tokens ORDER BY kind, address"
    )


def _build_calls(
    tokens: list[dict[str, Any]],
) -> tuple[list[tuple[str, bytes]], list[tuple[str, str]]]:
    """Build the Multicall3 batch.

    Returns ``(calls, plan)`` where ``plan[i] == (token_address, call_kind)``
    aligned with ``calls[i]`` for decoding. ``call_kind`` ∈ ``{"price",
    "supply"}``. Player prices target ``player_hook``, country prices target
    ``country_hook``; supplies target the token itself.
    """

    calls: list[tuple[str, bytes]] = []
    plan: list[tuple[str, str]] = []

    for row in tokens:
        addr = row["address"]
        kind = row["kind"]
        hook = config.player_hook if kind == "player" else config.country_hook
        if not hook:
            # Without a hook configured we can't fetch the price; emit a
            # zero-supply fallback to keep ``market_state`` shape consistent.
            continue
        calls.append((hook, _PRICE_SEL + _addr_padded(addr)))
        plan.append((addr, "price"))
        calls.append((addr, _SUPPLY_SEL))
        plan.append((addr, "supply"))

    return calls, plan


def _decode_results(
    plan: list[tuple[str, str]], results: list[bytes]
) -> dict[str, dict[str, int]]:
    """Group raw multicall returns into ``{address: {"price": w, "supply": w}}``."""

    if len(plan) != len(results):
        raise RuntimeError(f"multicall plan/result length mismatch: {len(plan)} vs {len(results)}")

    out: dict[str, dict[str, int]] = {}
    for (addr, kind), raw in zip(plan, results, strict=True):
        # allowFailure=True returns empty bytes on revert; treat as 0.
        value = 0 if not raw or len(raw) < 32 else int.from_bytes(raw[:32], "big")
        out.setdefault(addr, {})[kind] = value
    return out


def _trades_count(token_addr: str) -> int:
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM events WHERE token_address = %s", (token_addr,))
        row = cur.fetchone()
        return int(row["c"]) if row is not None else 0


def _holders_count(token_addr: str) -> int:
    """Distinct traders with positive net token_value (see port §5.1)."""

    sql = """
        SELECT COUNT(*) AS c FROM (
            SELECT trader_address,
                   SUM(CASE side WHEN 'buy' THEN token_value ELSE -token_value END) AS net
            FROM events
            WHERE token_address = %s
            GROUP BY trader_address
            HAVING SUM(CASE side WHEN 'buy' THEN token_value ELSE -token_value END) > 0
        ) sub
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, (token_addr,))
        row = cur.fetchone()
        return int(row["c"]) if row is not None else 0


def _change_pct(
    token_addr: str,
    p_now_pitch: float,
    country_price_pitch_now: float = 1.0,
) -> dict[str, float]:
    """Compute change_pct for each period, all in **PITCH-units** (spec §5.1).

    For period ``X``: ``p_then`` = market_price of the latest event with
    ``ts <= now() - X`` (for ``all`` — the very first ever event). Then
    ``change_pct_X = (p_now - p_then) / p_then * 100`` (0 if no event).

    Unit alignment:

    * For **country** tokens both ``p_now_pitch`` and ``market_price(event)``
      are already in PITCH — no conversion needed; caller passes
      ``country_price_pitch_now = 1.0``.
    * For **player** tokens events are denominated in the country token, so
      ``market_price(event)`` is in **country-units**. We multiply by the
      caller-supplied ``country_price_pitch_now`` to bring ``p_then`` into
      PITCH. This is an *approximation* — the country price at the event
      block was different — but the schema doesn't store per-event country
      snapshots, and the country price typically drifts slowly compared to
      player prices, so the resulting change_pct matches the spec's intent
      (numbers will be in the same ballpark as the portable my_wallet view).
    """

    out: dict[str, float] = {}
    if p_now_pitch <= 0:
        for name, _sec in _PERIODS:
            out[name] = 0.0
        return out

    for name, period_sec in _PERIODS:
        if period_sec is None:
            sql = """
                SELECT side, base_value, token_value, fee
                FROM events
                WHERE token_address = %s
                ORDER BY block_number ASC, log_index ASC
                LIMIT 1
            """
            params: tuple[Any, ...] = (token_addr,)
        else:
            sql = """
                SELECT side, base_value, token_value, fee
                FROM events
                WHERE token_address = %s AND ts <= now() - make_interval(secs => %s)
                ORDER BY block_number DESC, log_index DESC
                LIMIT 1
            """
            params = (token_addr, period_sec)

        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            row = cur.fetchone()
        if row is None:
            out[name] = 0.0
            continue
        p_then_native = market_price(
            row["side"], int(row["base_value"]), int(row["fee"]), int(row["token_value"])
        )
        # Bring `p_then` into PITCH (multiply by 1.0 for country tokens —
        # they already report market_price in PITCH directly).
        p_then_pitch = p_then_native * country_price_pitch_now
        if p_then_pitch <= 0:
            out[name] = 0.0
        else:
            out[name] = (p_now_pitch - p_then_pitch) / p_then_pitch * 100.0

    return out


def _upsert_market_state(
    addr: str,
    *,
    price_country_wei: int,
    price_pitch_wei: int,
    supply_wei: int,
    change_pct: dict[str, float],
    trades_count: int,
    holders_count: int,
) -> None:
    """UPSERT one row in ``market_state``."""

    now = datetime.now(tz=UTC)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO market_state (
                token_address, price_country, price_pitch, supply,
                change_pct_all, change_pct_1d, change_pct_12h,
                change_pct_6h, change_pct_1h, change_pct_15m,
                trades_count, holders_count, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (token_address) DO UPDATE SET
                price_country  = EXCLUDED.price_country,
                price_pitch    = EXCLUDED.price_pitch,
                supply         = EXCLUDED.supply,
                change_pct_all = EXCLUDED.change_pct_all,
                change_pct_1d  = EXCLUDED.change_pct_1d,
                change_pct_12h = EXCLUDED.change_pct_12h,
                change_pct_6h  = EXCLUDED.change_pct_6h,
                change_pct_1h  = EXCLUDED.change_pct_1h,
                change_pct_15m = EXCLUDED.change_pct_15m,
                trades_count   = EXCLUDED.trades_count,
                holders_count  = EXCLUDED.holders_count,
                updated_at     = EXCLUDED.updated_at
            """,
            (
                addr,
                int(price_country_wei),
                int(price_pitch_wei),
                int(supply_wei),
                change_pct["all"],
                change_pct["1d"],
                change_pct["12h"],
                change_pct["6h"],
                change_pct["1h"],
                change_pct["15m"],
                int(trades_count),
                int(holders_count),
                now,
            ),
        )
        conn.commit()


def tick() -> None:
    """One refresh of the entire ``market_state`` table."""

    global _LAST_PRICE_UPDATE_TS
    try:
        tokens = _load_tokens()
        if not tokens:
            log.debug("price_loop.skip", reason="tokens table is empty")
            return

        if not config.player_hook and not config.country_hook:
            log.debug("price_loop.skip", reason="hook addresses not configured")
            return

        w3 = _w3.get_w3()
        calls, plan = _build_calls(tokens)
        if not calls:
            log.debug("price_loop.skip", reason="no eligible calls (missing hook envs?)")
            return

        results = multicall3_aggregate(w3, calls, allow_failure=True)
        decoded = _decode_results(plan, results)

        # Country prices in PITCH — needed to compute price_pitch for players.
        country_price_pitch: dict[str, int] = {
            row["address"]: decoded.get(row["address"], {}).get("price", 0)
            for row in tokens
            if row["kind"] == "country"
        }

        updated = 0
        changed: list[str] = []
        for row in tokens:
            addr = row["address"]
            kind = row["kind"]
            d = decoded.get(addr, {})
            supply_wei = int(d.get("supply", 0))

            if kind == "country":
                # Country price is already in PITCH; price_country=0 (countries
                # trade against PITCH, not against another country — see schema
                # comment in db-schema.sql line 120).
                price_pitch_wei = int(d.get("price", 0))
                price_country_wei = 0
                p_now_for_change = float(Decimal(price_pitch_wei) / Decimal(WEI))
                country_price_pitch_now = 1.0  # event prices already in PITCH
            else:
                # Player: price-in-country wei from the hook.
                price_country_wei = int(d.get("price", 0))
                country_addr = row["country_address"]
                cp_pitch_wei = country_price_pitch.get(country_addr, 0)
                # price_pitch = price_country * country_price_pitch
                # Convert via Decimal to avoid float intermediate loss; result
                # stays in wei (divide by WEI once after the multiply).
                if price_country_wei > 0 and cp_pitch_wei > 0:
                    price_pitch_wei = int(
                        Decimal(price_country_wei) * Decimal(cp_pitch_wei) // Decimal(WEI)
                    )
                else:
                    price_pitch_wei = 0
                # change_pct in PITCH-units (spec §5.1) — pass current
                # country_price_pitch as a "good enough" multiplier for
                # historical events. Approximation acknowledged in _change_pct.
                p_now_for_change = float(Decimal(price_pitch_wei) / Decimal(WEI))
                country_price_pitch_now = float(Decimal(cp_pitch_wei) / Decimal(WEI))

            change_pct = _change_pct(addr, p_now_for_change, country_price_pitch_now)
            tc = _trades_count(addr)
            hc = _holders_count(addr)

            _upsert_market_state(
                addr,
                price_country_wei=price_country_wei,
                price_pitch_wei=price_pitch_wei,
                supply_wei=supply_wei,
                change_pct=change_pct,
                trades_count=tc,
                holders_count=hc,
            )
            updated += 1

            # Delta detection vs the previous in-memory tick. A change in
            # either price_pitch or price_country qualifies — the SSE
            # subscribers read the full market_state row anyway.
            addr_lc = addr.lower()
            prev = _PREV_PRICES.get(addr_lc)
            curr = (int(price_pitch_wei), int(price_country_wei))
            if prev != curr:
                changed.append(addr_lc)
                _PREV_PRICES[addr_lc] = curr

        # One NOTIFY per tick — payload is the list of changed addresses
        # (lowercase) per docs/db-schema.sql NOTIFY section. Empty list
        # would also be valid (stale-indicator), but we only need to send it
        # when the freshness threshold flips — that's a future enhancement.
        if changed:
            # Payload size budget: 192 addrs * (42 + 4 quoting) ≈ 9KB worst
            # case — over the ~8KB NOTIFY limit. Chunk by 150 to stay safe.
            CHUNK = 150
            for i in range(0, len(changed), CHUNK):
                notify("pt_prices", json.dumps(changed[i : i + CHUNK]))

        log.info("price_loop.tick", updated=updated, changed=len(changed))
        if updated > 0:
            _LAST_PRICE_UPDATE_TS = time.time()
            operator_alerts.record_price_fresh()
        else:
            # No rows updated this tick (no eligible tokens at all is handled
            # by the early returns above — reaching here means we ran calls
            # but nothing landed in market_state). Check staleness if we've
            # successfully updated at some point in the past.
            operator_alerts.record_price_stale(time.time(), _LAST_PRICE_UPDATE_TS)
        operator_alerts.record_tick_success("price_loop")
    except Exception:
        log.exception("price_loop.tick_failed")
        operator_alerts.record_tick_failure("price_loop")
        operator_alerts.record_price_stale(time.time(), _LAST_PRICE_UPDATE_TS)


__all__ = ["tick"]
