"""Integration tests for ``GET /api/v1/profile`` (api-spec §6.1)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import psycopg
import pytest

from app import create_app
from app.routes import profile as profile_route
from shared import access as access_mod
from shared import jwt as jwt_mod

_COUNTRY = "0x" + "11" * 20
_PLAYER = "0x" + "22" * 20
_WALLET = "0x" + "ab" * 20
_CONTRACT = "0x" + "ee" * 20
_PITCH_TOKEN = "0x" + "ff" * 20


@contextmanager
def _premium(*, has_access: bool):
    """Force ``is_premium`` to return ``has_access`` without touching RPC.

    Replaces the legacy ``PREMIUM_STUB_BYPASS`` env switch — see B0.12.
    """

    access_mod.reset_cache()
    with (
        patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
        patch.object(access_mod, "_rpc_has_access", return_value=has_access),
    ):
        try:
            yield
        finally:
            access_mod.reset_cache()


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture(autouse=True)
def _seed_tokens(_clean_tokens_table) -> Iterator[None]:
    """Seed: 1 country + 1 player + market_state rows for both.

    Depends on conftest's autouse ``_clean_tokens_table`` so the truncate
    happens *before* the seed.
    """

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL)",
                (_COUNTRY,),
            )
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Pele', 'PEL', 'player', %s, 'captain')",
                (_PLAYER, _COUNTRY),
            )
            # Country priced 3 PITCH each, supply 100.
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, 0, %s, %s)",
                (_COUNTRY, 3 * 10**18, 100 * 10**18),
            )
            # Player priced 6 PITCH each (= 2 country units * 3 PITCH/country), supply 50.
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, %s, %s, %s)",
                (_PLAYER, 2 * 10**18, 6 * 10**18, 50 * 10**18),
            )
        conn.commit()
    yield


def _set_session(client, address: str) -> None:
    token = jwt_mod.encode(address)
    client.set_cookie("pt_session", token, domain="localhost")


def _insert_event(
    block: int,
    log_index: int,
    token: str,
    trader: str,
    side: str,
    base_value: int,
    token_value: int,
    fee: int,
) -> None:
    tx_hash = "0x" + f"{block:064x}"
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO events "
                "(block_number, tx_hash, log_index, token_address, side, trader_address, "
                " base_value, token_value, fee, ts) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, to_timestamp(%s))",
                (
                    block,
                    tx_hash,
                    log_index,
                    token,
                    side,
                    trader,
                    base_value,
                    token_value,
                    fee,
                    1_700_000_000 + block,
                ),
            )
        conn.commit()


class TestAccessControl:
    def test_no_cookie_returns_401(self, app) -> None:
        resp = app.test_client().get("/api/v1/profile")
        assert resp.status_code == 401
        assert resp.get_json()["code"] == "auth.unauthenticated"

    def test_authed_but_no_premium_returns_402(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=False):
            resp = client.get("/api/v1/profile")
        assert resp.status_code == 402
        assert resp.get_json()["code"] == "access.payment_required"


class TestEmptyProfile:
    """Authed + premium granted but the wallet has zero trades."""

    def test_empty_envelope(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile")
        assert resp.status_code == 200
        body = resp.get_json()
        # Top-level keys per spec §6.1.
        assert set(body.keys()) >= {
            "address",
            "summary",
            "positions",
            "closed",
            "trades",
            "stats",
            "allocation",
            "balances",
            "valueSeries",
        }
        assert body["address"] == _WALLET
        assert body["positions"] == []
        assert body["closed"] == []
        assert body["trades"]["items"] == []
        assert body["trades"]["limit"] == 100
        assert body["trades"]["nextCursor"] is None
        assert body["summary"]["openPositions"] == 0
        assert body["stats"]["totalTrades"] == 0


class TestProfileAggregates:
    """Wallet has activity on both a player and a country token."""

    def test_open_position_and_realized(self, app) -> None:
        # On _PLAYER: buy 2, sell 1 (held: 1). On _COUNTRY: buy 5 (held: 5).
        _insert_event(100, 0, _PLAYER, _WALLET, "buy", 4 * 10**18, 2 * 10**18, 2 * 10**17)
        _insert_event(101, 0, _PLAYER, _WALLET, "sell", 3 * 10**18, 10**18, 10**17)
        _insert_event(102, 0, _COUNTRY, _WALLET, "buy", 15 * 10**18, 5 * 10**18, 5 * 10**17)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile")
        assert resp.status_code == 200
        body = resp.get_json()

        # Two open positions (player still has 1 token, country has 5).
        assert body["summary"]["openPositions"] == 2
        assert body["stats"]["totalTrades"] == 3
        assert body["stats"]["buys"] == 2
        assert body["stats"]["sells"] == 1
        symbols = {p["symbol"] for p in body["positions"]}
        assert symbols == {"PEL", "BRA"}
        # All open positions get a sharePct that sums to ~100.
        share_sum = sum(p["sharePct"] for p in body["positions"])
        assert share_sum == pytest.approx(100.0, abs=0.2)

    def test_trades_pagination(self, app) -> None:
        # Insert 5 wallet trades; request limit=2 → expect nextCursor + items=2.
        for i in range(5):
            _insert_event(200 + i, 0, _PLAYER, _WALLET, "buy", 10**18, 10**18, 10**16)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile?tradesLimit=2")
            assert resp.status_code == 200
            body = resp.get_json()
            assert len(body["trades"]["items"]) == 2
            assert body["trades"]["limit"] == 2
            assert body["trades"]["nextCursor"] is not None

            # Follow the cursor — should yield the next 2.
            resp2 = client.get(
                f"/api/v1/profile?tradesLimit=2&tradesCursor={body['trades']['nextCursor']}"
            )
        body2 = resp2.get_json()
        assert len(body2["trades"]["items"]) == 2
        # Returned in DESC order; second page's first item must be older than the first
        # page's last item.
        assert body2["trades"]["items"][0]["timestamp"] < body["trades"]["items"][-1]["timestamp"]

    def test_bad_cursor_returns_400(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile?tradesCursor=!!!bogus!!!")
        assert resp.status_code == 400
        assert resp.get_json()["code"] == "validation.bad_request"


# ─── B0.13: balances + historical valueSeries ──────────────────────────────


def _stub_w3(eth_wei: int, balances_by_addr: dict[str, int]) -> MagicMock:
    """Build a stub Web3 the ``wallet_balances`` helper can drive.

    See test_eth.TestWalletBalances for the mock contract — same shape here,
    just plumbed through the route's ``_get_w3`` indirection.
    """

    w3 = MagicMock()
    w3.eth.get_balance.return_value = eth_wei
    w3.to_checksum_address.side_effect = lambda a: a

    # The contract handle returns ``aggregate3(...).call()`` = list[(ok, bytes)].
    # ``wallet_balances`` issues calls in order [PITCH (if set), countries...].
    # We can't know the order here without inspecting calldata, so build the
    # result list dynamically from the calldata the helper passes.
    def aggregate3_side_effect(calls: list[tuple[str, bool, bytes]]):
        runner = MagicMock()
        results = []
        for target, _allow, _cd in calls:
            wei = balances_by_addr.get(target.lower(), 0)
            results.append((True, wei.to_bytes(32, "big")))
        runner.call.return_value = results
        return runner

    w3.eth.contract.return_value.functions.aggregate3.side_effect = aggregate3_side_effect
    return w3


class TestBalances:
    """B0.13.balances — Multicall-backed wallet balances replace the zero-stub."""

    def test_balances_populated_from_chain(self, app) -> None:
        # Wallet holds: 1 ETH, 100 PITCH, 50 BRA tokens.
        w3 = _stub_w3(
            eth_wei=10**18,
            balances_by_addr={
                _PITCH_TOKEN.lower(): 100 * 10**18,
                _COUNTRY: 50 * 10**18,
            },
        )
        client = app.test_client()
        _set_session(client, _WALLET)
        with (
            _premium(has_access=True),
            patch.object(profile_route, "_get_pitch_token", return_value=_PITCH_TOKEN.lower()),
            patch.object(profile_route, "_get_w3", return_value=w3),
        ):
            resp = client.get("/api/v1/profile")
        assert resp.status_code == 200
        body = resp.get_json()
        bal = body["balances"]
        assert bal["ethWei"] == str(10**18)
        assert bal["pitchWei"] == str(100 * 10**18)
        assert bal["countries"] == [{"address": _COUNTRY, "symbol": "BRA", "wei": str(50 * 10**18)}]

    def test_balances_falls_back_to_stub_on_rpc_error(self, app) -> None:
        """If the RPC call raises, route returns the zero-stub shape (never 500)."""

        client = app.test_client()
        _set_session(client, _WALLET)
        with (
            _premium(has_access=True),
            patch.object(profile_route, "_get_pitch_token", return_value=_PITCH_TOKEN.lower()),
            patch.object(profile_route, "_get_w3", side_effect=RuntimeError("rpc down")),
        ):
            resp = client.get("/api/v1/profile")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["balances"] == {"ethWei": "0", "pitchWei": "0", "countries": []}

    def test_balances_zero_filtered_from_countries(self, app) -> None:
        w3 = _stub_w3(
            eth_wei=0,
            balances_by_addr={_PITCH_TOKEN.lower(): 0, _COUNTRY: 0},
        )
        client = app.test_client()
        _set_session(client, _WALLET)
        with (
            _premium(has_access=True),
            patch.object(profile_route, "_get_pitch_token", return_value=_PITCH_TOKEN.lower()),
            patch.object(profile_route, "_get_w3", return_value=w3),
        ):
            resp = client.get("/api/v1/profile")
        body = resp.get_json()
        assert body["balances"]["countries"] == []


class TestValueSeriesHistorical:
    """B0.13.value_series — valueSeries samples at historical event prices."""

    def test_uses_historical_country_price(self, app) -> None:
        # Phase 1 (T=...01): country @ 2 PITCH. Wallet buys 5 BRA (cost 10).
        # Phase 2 (T=...02): some other trader moves country to 4 PITCH.
        # Wallet doesn't trade in phase 2, but the LAST tail point in
        # valueSeries (anchored to "now") uses current market_state
        # (which fixture seeded at 3 PITCH/country) → 15.
        # The wallet-trade point at phase 1 must value the BRA holding at the
        # phase-1 price (5 * 2 = 10) — NOT at current (3) which would give 15.
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10 * 10**18, 5 * 10**18, 0)
        # Non-wallet trader moves the market in a later block. base/token=4:
        # 20 PITCH for 5 BRA = 4 PITCH/BRA.
        _other_trader = "0x" + "cc" * 20
        _insert_event(200, 0, _COUNTRY, _other_trader, "buy", 20 * 10**18, 5 * 10**18, 0)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile")
        body = resp.get_json()
        series = body["valueSeries"]
        assert len(series) >= 2
        # The first series entry corresponds to the wallet's only trade at
        # block 100 — value should be 5 BRA * 2 PITCH = 10.
        first = series[0]
        assert first["value"] == pytest.approx(10.0, abs=0.01)

    def test_uses_historical_player_price_chain(self, app) -> None:
        # Player tokens value through the two-leg chain:
        #   player_in_country (player events) * country_in_pitch (country events).
        # Both legs must be sampled at the wallet-trade ts, not at current state.
        #
        # block  50: country event — 10 PITCH for 5 BRA → country_in_pitch = 2.
        # block  80: player event by other trader — 6 BRA for 3 PEL →
        #            player_in_country = 2 country/PEL.
        # block 100: wallet buys 4 PEL for 8 BRA (same player_in_country = 2).
        #
        # Expected at wallet-trade ts: 4 PEL * 2 * 2 = 16 PITCH.
        # Current state (fixture seed) would give 4 * 6 = 24 — distinguishes
        # historical chain from current-price shortcut.
        _other = "0x" + "cc" * 20
        _insert_event(50, 0, _COUNTRY, _other, "buy", 10 * 10**18, 5 * 10**18, 0)
        _insert_event(80, 0, _PLAYER, _other, "buy", 6 * 10**18, 3 * 10**18, 0)
        _insert_event(100, 0, _PLAYER, _WALLET, "buy", 8 * 10**18, 4 * 10**18, 0)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile")
        body = resp.get_json()
        series = body["valueSeries"]
        assert len(series) >= 1
        first = series[0]
        assert first["value"] == pytest.approx(16.0, abs=0.01)

    def test_intermediate_points_use_each_moments_historical_price(self, app) -> None:
        """Every wallet-trade point (not just the first) values held tokens at
        the historical price of *that* moment.

        This is the user-reported scenario: country tokens (and the player
        price chain) must be marked-to-market at each intermediate point's
        historical price, NOT at the current market price. We build two wallet
        trades at different timestamps with the country price moving in between
        (via a non-wallet trader), plus a player position whose two-leg chain
        is sampled at the later timestamp.

        Timeline (ts = 1_700_000_000 + block):
          block 100  CTY  wallet  buy 5 for 10 PITCH  -> country curve = 2 PITCH
          block 200  CTY  other   buy 5 for 30 PITCH  -> country moves to 6 PITCH
          block 250  PLR  other   buy 3 for 6 BRA     -> player_in_country = 2
          block 300  PLR  wallet  buy 4 for 8 BRA      (player_in_country = 2)

        Expected valueSeries (the two wallet-trade points):
          @ block-100 ts: holdings {CTY:5}; country@2  -> 5 * 2          = 10
          @ block-300 ts: holdings {CTY:5, PLR:4};
              country@6 (nearest <= ts is block 200)    -> 5 * 6          = 30
              player@(2 country/PEL * 6 PITCH/country=12)-> 4 * 12         = 48
                                                          -----------------------
                                                          total            = 78

        The tail "now" point uses current market_state (fixture: CTY=3, PLR=6
        PITCH) -> 5*3 + 4*6 = 39, which deliberately differs from 78 so a
        regression that reused the current price for the historical points
        would surface as the block-300 point reading 39 instead of 78.
        """

        _other = "0x" + "cc" * 20
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10 * 10**18, 5 * 10**18, 0)
        _insert_event(200, 0, _COUNTRY, _other, "buy", 30 * 10**18, 5 * 10**18, 0)
        _insert_event(250, 0, _PLAYER, _other, "buy", 6 * 10**18, 3 * 10**18, 0)
        _insert_event(300, 0, _PLAYER, _WALLET, "buy", 8 * 10**18, 4 * 10**18, 0)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile")
        body = resp.get_json()
        series = body["valueSeries"]
        # Two wallet-trade points + one tail "now" point.
        assert len(series) == 3
        # Sorted by time ascending; first = block 100, second = block 300.
        by_time = {pt["time"]: pt["value"] for pt in series}
        ts1 = 1_700_000_000 + 100
        ts2 = 1_700_000_000 + 300
        assert by_time[ts1] == pytest.approx(10.0, abs=0.01)
        assert by_time[ts2] == pytest.approx(78.0, abs=0.01)
        # The tail point ("now") is the current-price valuation = 39, distinct
        # from the historical block-300 point (78). Confirms the loop never
        # leaked the current price into the historical points.
        tail = series[-1]
        assert tail["time"] not in (ts1, ts2)
        assert tail["value"] == pytest.approx(39.0, abs=0.01)

    def test_sold_position_drops_out_of_later_points(self, app) -> None:
        """A token fully sold before a later trade contributes 0 to subsequent
        points (holdings goes to ~0, the per-token guard skips it)."""

        # block 100: buy 5 CTY for 10 PITCH (country curve = 2 PITCH).
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10 * 10**18, 5 * 10**18, 0)
        # block 200: sell all 5 CTY for 20 PITCH (country curve = 4 PITCH).
        _insert_event(200, 0, _COUNTRY, _WALLET, "sell", 20 * 10**18, 5 * 10**18, 0)
        # block 300: buy 2 PLR for 4 BRA. Country@300 = 4 (nearest <= ts is
        # block 200), player_in_country = 2 -> player = 2 * 4 = 8 PITCH.
        _insert_event(300, 0, _PLAYER, _WALLET, "buy", 4 * 10**18, 2 * 10**18, 0)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile")
        series = resp.get_json()["valueSeries"]
        by_time = {pt["time"]: pt["value"] for pt in series}
        ts_buy = 1_700_000_000 + 100
        ts_sell = 1_700_000_000 + 200
        ts_player = 1_700_000_000 + 300
        # @100: 5 CTY * 2 = 10.
        assert by_time[ts_buy] == pytest.approx(10.0, abs=0.01)
        # @200: CTY fully sold -> 0 contribution.
        assert by_time[ts_sell] == pytest.approx(0.0, abs=0.01)
        # @300: only 2 PLR held; CTY no longer contributes. 2 * (2 * 4) = 16.
        assert by_time[ts_player] == pytest.approx(16.0, abs=0.01)
