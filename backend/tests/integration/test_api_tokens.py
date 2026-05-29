"""Integration tests for ``/api/v1/tokens`` family (api-spec §4)."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest

from app import create_app
from scripts import seed_tokens

_TOKENS_JSON = Path(__file__).resolve().parents[2] / "data" / "tokens.json"


def _connect() -> psycopg.Connection:
    return psycopg.connect(os.environ["DATABASE_URL"])


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture()
def seeded_tokens() -> dict[str, str]:
    """Run the seed, return a small dict of useful addresses for assertions."""

    seed_tokens.seed(_TOKENS_JSON)
    with _connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT address FROM tokens WHERE kind='country' LIMIT 1")
        c_row = cur.fetchone()
        cur.execute("SELECT address FROM tokens WHERE kind='player' LIMIT 1")
        p_row = cur.fetchone()
    assert c_row is not None and p_row is not None
    return {"country": c_row[0].strip(), "player": p_row[0].strip()}


class TestListTokens:
    """spec §4.1 — `/api/v1/tokens` lists + lastUpdate + stale."""

    def test_empty_when_no_seed(self, app) -> None:
        resp = app.test_client().get("/api/v1/tokens")
        assert resp.status_code == 200
        body = resp.get_json()
        # Empty payload still has the spec envelope.
        assert body["players"] == []
        assert body["countries"] == []
        assert body["lastUpdate"] is None
        assert body["stale"] is True  # no update → considered stale

    def test_returns_all_when_seeded(self, app, seeded_tokens) -> None:
        resp = app.test_client().get("/api/v1/tokens")
        assert resp.status_code == 200
        body = resp.get_json()
        # 144 regular players + 11 icon tokens (icons are kind='player').
        assert len(body["players"]) == 144 + 11
        assert len(body["countries"]) == 48

        # Spec §4.1: players carry name, role, country (NAME), countryAddress.
        for p in body["players"]:
            assert isinstance(p["country"], str) and p["country"] != ""
            assert p["countryAddress"].startswith("0x") and len(p["countryAddress"]) == 42
            assert p["role"] in {"best", "captain", "rookie"}

        # Countries must NOT have player-specific keys.
        for c in body["countries"]:
            assert "role" not in c
            assert "country" not in c
            assert "countryAddress" not in c

    def test_icons_appear_in_players_with_flag(self, app, seeded_tokens) -> None:
        resp = app.test_client().get("/api/v1/tokens")
        body = resp.get_json()
        # Exactly 11 player rows carry isIcon=true; regular players omit it.
        icons = [p for p in body["players"] if p.get("isIcon")]
        assert len(icons) == 11
        for ic in icons:
            assert ic["isIcon"] is True
            assert ic["role"] in {"best", "captain", "rookie"}
            assert ic["countryAddress"].startswith("0x")
        # Regular (non-icon) players don't emit the flag at all.
        non_icon = [p for p in body["players"] if not p.get("isIcon")]
        assert len(non_icon) == 144
        assert all("isIcon" not in p for p in non_icon)

    def test_zero_market_state(self, app, seeded_tokens) -> None:
        resp = app.test_client().get("/api/v1/tokens")
        body = resp.get_json()
        for t in body["players"]:
            assert t["pricePitch"] == 0
            assert t["holdersCount"] == 0
            assert t["tradesCount"] == 0
            assert t["changePct"]["all"] == 0

    def test_sorted_by_price_pitch_desc(self, app) -> None:
        """Known-issue #7: tokens are returned sorted by pricePitch DESC.

        NULLS LAST keeps un-priced tokens after priced ones; a stable
        ``address ASC`` tiebreaker keeps the order deterministic when several
        tokens share the same price (the common case during worker backfill).
        """

        with _connect() as conn, conn.cursor() as cur:
            # Cheapest first so the ORDER BY actually has work to do — if the
            # query forgot to sort, the response would echo this insert order.
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES "
                "(%s, 'Country A', 'CA', 'country', NULL, NULL),"
                "(%s, 'Country B', 'CB', 'country', NULL, NULL),"
                "(%s, 'Country C', 'CC', 'country', NULL, NULL)",
                (
                    "0x" + "a" * 40,
                    "0x" + "b" * 40,
                    "0x" + "c" * 40,
                ),
            )
            # Player rows with mixed prices (incl. a tie at 0 and an unpriced row).
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES "
                "(%s, 'P low', 'PL', 'player', %s, 'rookie'),"
                "(%s, 'P high', 'PH', 'player', %s, 'best'),"
                "(%s, 'P zero1', 'P1', 'player', %s, 'captain'),"
                "(%s, 'P zero2', 'P2', 'player', %s, 'captain'),"
                "(%s, 'P unpriced', 'PU', 'player', %s, 'rookie')",
                (
                    "0x" + "1" * 40,
                    "0x" + "a" * 40,
                    "0x" + "2" * 40,
                    "0x" + "a" * 40,
                    "0x" + "3" * 40,
                    "0x" + "a" * 40,
                    "0x" + "4" * 40,
                    "0x" + "a" * 40,
                    "0x" + "5" * 40,
                    "0x" + "a" * 40,
                ),
            )
            # Country prices: A=10e18, B=1e18, C=0
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES "
                "(%s, 0, %s, 0),"
                "(%s, 0, %s, 0),"
                "(%s, 0, %s, 0)",
                (
                    "0x" + "a" * 40,
                    10 * 10**18,
                    "0x" + "b" * 40,
                    1 * 10**18,
                    "0x" + "c" * 40,
                    0,
                ),
            )
            # Player prices: low=5e18, high=100e18, zero1=0, zero2=0.
            # `unpriced` deliberately has no market_state row → NULL price.
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES "
                "(%s, 0, %s, 0),"
                "(%s, 0, %s, 0),"
                "(%s, 0, %s, 0),"
                "(%s, 0, %s, 0)",
                (
                    "0x" + "1" * 40,
                    5 * 10**18,
                    "0x" + "2" * 40,
                    100 * 10**18,
                    "0x" + "3" * 40,
                    0,
                    "0x" + "4" * 40,
                    0,
                ),
            )
            conn.commit()

        resp = app.test_client().get("/api/v1/tokens")
        assert resp.status_code == 200
        body = resp.get_json()

        # Countries: A (10) > B (1) > C (0).
        country_addrs = [c["address"] for c in body["countries"]]
        assert country_addrs == ["0x" + "a" * 40, "0x" + "b" * 40, "0x" + "c" * 40]

        # Players: high (100) > low (5) > zero1/zero2 tied at 0 (address ASC:
        # 0x3... before 0x4...) > unpriced (NULL → last).
        player_addrs = [p["address"] for p in body["players"]]
        assert player_addrs == [
            "0x" + "2" * 40,  # 100
            "0x" + "1" * 40,  # 5
            "0x" + "3" * 40,  # 0, addr 0x3... wins tiebreak
            "0x" + "4" * 40,  # 0, addr 0x4...
            "0x" + "5" * 40,  # NULL → last
        ]

    def test_ask_bid_quotes_in_response(self, app) -> None:
        """Directional quotes from market_state surface as wei-strings."""

        addr = "0x" + "a" * 40
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL)",
                (addr,),
            )
            cur.execute(
                "INSERT INTO market_state "
                "(token_address, price_country, price_pitch, supply, "
                " ask_quote_per_base, bid_quote_per_base) "
                "VALUES (%s, 0, %s, 0, %s, %s)",
                (
                    addr,
                    10 * 10**18,  # MID = 10
                    (10 * 10**18 * 10_000) // 9_500,  # ASK = MID / 0.95
                    (10 * 10**18 * 9_500) // 10_000,  # BID = MID * 0.95
                ),
            )
            conn.commit()

        resp = app.test_client().get("/api/v1/tokens")
        body = resp.get_json()
        country = next(c for c in body["countries"] if c["address"] == addr)
        # Wei-strings; MID stays a float (price_pitch / 1e18).
        assert country["pricePitch"] == 10.0
        assert country["askPrice"] == str((10 * 10**18 * 10_000) // 9_500)
        assert country["bidPrice"] == str((10 * 10**18 * 9_500) // 10_000)
        # The ASK strictly exceeds MID; BID strictly below MID.
        assert int(country["askPrice"]) > 10 * 10**18
        assert int(country["bidPrice"]) < 10 * 10**18

    def test_ask_bid_null_when_worker_hasnt_populated(self, app) -> None:
        """Missing quote columns surface as ``None`` (frontend renders MID only)."""

        addr = "0x" + "b" * 40
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Argentina', 'ARG', 'country', NULL, NULL)",
                (addr,),
            )
            # No ask/bid columns set → NULL by default.
            cur.execute(
                "INSERT INTO market_state "
                "(token_address, price_country, price_pitch, supply) "
                "VALUES (%s, 0, %s, 0)",
                (addr, 5 * 10**18),
            )
            conn.commit()

        resp = app.test_client().get("/api/v1/tokens")
        body = resp.get_json()
        country = next(c for c in body["countries"] if c["address"] == addr)
        assert country["askPrice"] is None
        assert country["bidPrice"] is None


class TestChart:
    """spec §4.2 — `/chart` returns `{kind, name, symbol, country, candles, points}`."""

    def test_unknown_token_404(self, app) -> None:
        resp = app.test_client().get(
            "/api/v1/tokens/0x0000000000000000000000000000000000000000/chart"
        )
        assert resp.status_code == 404
        assert resp.mimetype == "application/problem+json"
        body = resp.get_json()
        assert body["code"] == "tokens.unknown"

    def test_invalid_address_format_404(self, app) -> None:
        resp = app.test_client().get("/api/v1/tokens/0xINVALID/chart")
        assert resp.status_code == 404
        body = resp.get_json()
        assert body["code"] == "tokens.unknown"

    def test_empty_chart_for_country(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["country"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m")
        assert resp.status_code == 200
        body = resp.get_json()
        # spec §4.2 envelope must be present even on empty events.
        assert body["kind"] == "country"
        assert "name" in body
        assert "symbol" in body
        assert body["country"] == ""  # countries don't have a parent country
        assert body["candles"] == []
        assert body["points"] == []  # no spot point either: market_state missing

    def test_player_chart_includes_country_name(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["player"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["kind"] == "player"
        assert isinstance(body["country"], str) and body["country"] != ""

    def test_bad_tf(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["country"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=bogus")
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["code"] == "validation.bad_request"

    def test_line_is_rejected_now(self, app, seeded_tokens) -> None:
        # `line` was a custom extension in the pre-spec implementation. Per
        # spec §4.2 valid tf values are 1m|5m|15m|1h|4h|1d only — line is gone.
        addr = seeded_tokens["country"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=line")
        assert resp.status_code == 400


class TestChartUnit:
    """spec §4.2 — `unit=pitch|country` denomination toggle.

    Player tokens trade against their parent country (events carry country-
    denominated `base_value`). `unit=pitch` (default) multiplies OHLC by the
    historical country→PITCH price; `unit=country` keeps the native
    denomination. Country tokens are PITCH-native — both units collapse.
    """

    # Two distinct addresses used across the tests — kept short for readability.
    _COUNTRY = "0x" + "11" * 20
    _PLAYER = "0x" + "22" * 20
    # Three reference timestamps spaced 200s apart so we can bucket into 5m
    # candles (300s) without collisions and still sit «around» events.
    _T1 = 1_700_000_000
    _T2 = _T1 + 200
    _T3 = _T2 + 200

    @pytest.fixture()
    def seeded_player_with_country_trades(self):
        """Seed: 1 country + 1 player, country trades T1 + T2, player trades T2 + T3.

        Country price-in-PITCH = 2.0 from T1, 4.0 from T2 onwards.
        Player price-in-country = 0.5 at T2, 1.0 at T3.
        Expected PITCH prices: 0.5 * 4.0 = 2.0 at T2; 1.0 * 4.0 = 4.0 at T3.
        """

        from shared.config import WEI

        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL),"
                "(%s, 'Pele', 'PEL', 'player', %s, 'captain')",
                (self._COUNTRY, self._PLAYER, self._COUNTRY),
            )

            def ins(
                block: int,
                token: str,
                side: str,
                base_value: int,
                token_value: int,
                ts: int,
            ) -> None:
                tx = "0x" + f"{block:064x}"
                cur.execute(
                    "INSERT INTO events "
                    "(block_number, tx_hash, log_index, token_address, side, "
                    " trader_address, base_value, token_value, fee, ts) "
                    "VALUES (%s, %s, 0, %s, %s, %s, %s, %s, 0, to_timestamp(%s))",
                    (block, tx, token, side, "0x" + "aa" * 20, base_value, token_value, ts),
                )

            # Country: T1 → 2 PITCH per token (10 / 5); T2 → 4 PITCH (20 / 5).
            ins(100, self._COUNTRY, "buy", 10 * WEI, 5 * WEI, self._T1)
            ins(101, self._COUNTRY, "buy", 20 * WEI, 5 * WEI, self._T2)
            # Player: T2 → 0.5 country per token (1 / 2); T3 → 1.0 country (3 / 3).
            ins(200, self._PLAYER, "buy", 1 * WEI, 2 * WEI, self._T2)
            ins(201, self._PLAYER, "buy", 3 * WEI, 3 * WEI, self._T3)
            conn.commit()
        return {"country": self._COUNTRY, "player": self._PLAYER}

    @pytest.fixture()
    def seeded_player_with_no_country_address(self):
        """Player row with country_address=NULL — conversion to PITCH impossible.

        The schema CHECK constraint forbids `kind='player' AND country_address IS NULL`
        in production (see docs/db-schema.sql §tokens), so we drop the constraint
        for the lifetime of this fixture to verify the endpoint's defensive 400
        path. The `_clean_tokens_table` autouse fixture truncates between tests;
        we re-add the constraint at teardown so neighbour tests stay isolated.
        """

        with _connect() as conn, conn.cursor() as cur:
            cur.execute("ALTER TABLE tokens DROP CONSTRAINT tokens_player_must_have_country")
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Orphan', 'ORP', 'player', NULL, 'rookie')",
                (self._PLAYER,),
            )
            conn.commit()
        try:
            yield self._PLAYER
        finally:
            # Wipe the offending row BEFORE re-adding the CHECK — otherwise
            # the ADD CONSTRAINT validates existing rows and fails. The
            # autouse `_clean_tokens_table` only runs on next-test setup,
            # which would be too late.
            with _connect() as conn, conn.cursor() as cur:
                cur.execute("TRUNCATE TABLE tokens CASCADE")
                cur.execute(
                    "ALTER TABLE tokens ADD CONSTRAINT tokens_player_must_have_country "
                    "CHECK ((kind = 'country' AND country_address IS NULL AND role IS NULL) "
                    "OR (kind = 'player' AND country_address IS NOT NULL AND role IS NOT NULL))"
                )
                conn.commit()

    @pytest.fixture()
    def seeded_player_traded_before_country(self):
        """Player event predates ALL country events — conversion has no ratio."""

        from shared.config import WEI

        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL),"
                "(%s, 'Pele', 'PEL', 'player', %s, 'captain')",
                (self._COUNTRY, self._PLAYER, self._COUNTRY),
            )

            def ins(
                block: int,
                token: str,
                side: str,
                base_value: int,
                token_value: int,
                ts: int,
            ) -> None:
                tx = "0x" + f"{block:064x}"
                cur.execute(
                    "INSERT INTO events "
                    "(block_number, tx_hash, log_index, token_address, side, "
                    " trader_address, base_value, token_value, fee, ts) "
                    "VALUES (%s, %s, 0, %s, %s, %s, %s, %s, 0, to_timestamp(%s))",
                    (block, tx, token, side, "0x" + "aa" * 20, base_value, token_value, ts),
                )

            # Player trades at T1, country only trades from T2 onwards.
            ins(200, self._PLAYER, "buy", 1 * WEI, 2 * WEI, self._T1)
            ins(100, self._COUNTRY, "buy", 20 * WEI, 5 * WEI, self._T2)
            conn.commit()
        return {"country": self._COUNTRY, "player": self._PLAYER}

    def test_bad_unit_400(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["country"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart?unit=bogus")
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["code"] == "validation.bad_request"

    def test_default_unit_is_pitch(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["country"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["unit"] == "pitch"

    def test_unit_pitch_equals_default_for_country(self, app, seeded_tokens) -> None:
        # Country tokens are PITCH-native → unit=pitch must equal the no-unit response.
        addr = seeded_tokens["country"]
        resp_default = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m")
        resp_pitch = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m&unit=pitch")
        assert resp_default.status_code == 200
        assert resp_pitch.status_code == 200
        assert resp_default.get_json()["candles"] == resp_pitch.get_json()["candles"]
        assert resp_default.get_json()["points"] == resp_pitch.get_json()["points"]

    def test_unit_country_for_country_token_is_passthrough(self, app, seeded_tokens) -> None:
        # For country tokens unit=country has no work to do → equivalent to pitch.
        addr = seeded_tokens["country"]
        resp_pitch = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m&unit=pitch")
        resp_country = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m&unit=country")
        assert resp_pitch.status_code == 200
        assert resp_country.status_code == 200
        assert resp_pitch.get_json()["candles"] == resp_country.get_json()["candles"]
        assert resp_pitch.get_json()["points"] == resp_country.get_json()["points"]

    def test_unit_country_for_player_keeps_native_units(
        self, app, seeded_player_with_country_trades
    ) -> None:
        addr = seeded_player_with_country_trades["player"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m&unit=country")
        assert resp.status_code == 200
        body = resp.get_json()
        # Two trade points (T2 = 0.5, T3 = 1.0 native country units).
        trade_points = [p for p in body["points"] if p["type"] != "spot"]
        assert len(trade_points) == 2
        assert trade_points[0]["price"] == pytest.approx(0.5)
        assert trade_points[1]["price"] == pytest.approx(1.0)

    def test_unit_pitch_for_player_converts_via_country_price(
        self, app, seeded_player_with_country_trades
    ) -> None:
        addr = seeded_player_with_country_trades["player"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m&unit=pitch")
        assert resp.status_code == 200
        body = resp.get_json()
        # Country price at T2 = 4.0 PITCH (after the T2 country trade);
        # at T3 also = 4.0 (no later country trade).
        # Player: 0.5 country at T2 → 2.0 PITCH; 1.0 country at T3 → 4.0 PITCH.
        trade_points = [p for p in body["points"] if p["type"] != "spot"]
        assert len(trade_points) == 2
        assert trade_points[0]["price"] == pytest.approx(2.0)
        assert trade_points[1]["price"] == pytest.approx(4.0)
        # Candles must also be converted. With 5m TF and these timestamps,
        # T2 and T3 fall into the same bucket so we get one candle with
        # open=2.0, close=4.0, high=4.0, low=2.0.
        assert len(body["candles"]) >= 1
        first = body["candles"][0]
        assert first["open"] == pytest.approx(2.0)
        # All four OHLC values are positive PITCH-denominated numbers.
        for key in ("open", "high", "low", "close"):
            assert first[key] > 0

    @pytest.fixture()
    def seeded_historical_rate_change(self):
        """Seed designed to catch «stale rate» regression: country price changes
        between two player trades.

        Country: rate=2 PITCH/country at T1, then rate=10 PITCH/country at T5
        (intervening). Player: constant 1.0 country/player at T2 (between T1
        and T5) and again at T6 (after T5).

        Correct historical-rate semantics → player[T2] = 1.0 * 2 = 2.0 PITCH,
        player[T6] = 1.0 * 10 = 10.0 PITCH (different — rising shape).

        Broken «always use latest country rate» → both player events scale by
        10.0 → both = 10.0 PITCH (flat shape == country-mode shape * const).

        This fixture is necessary because ``seeded_player_with_country_trades``
        places ALL player events at-or-after the last country event, so any
        implementation that uses «latest rate» would pass it silently.
        """

        from shared.config import WEI

        # Distinct addresses so we don't collide with siblings in same file.
        country = "0x" + "33" * 20
        player = "0x" + "44" * 20
        # 5m bucket = 300s. T1..T6 spaced so trades sit in different buckets,
        # making the OHLC assertion unambiguous.
        t1 = 1_700_010_000
        t2 = t1 + 400  # +6.67m  → next 5m bucket after T1
        t5 = t1 + 1000  # +16.67m → 2 buckets after T2
        t6 = t1 + 1400  # +23.3m  → 1 bucket after T5

        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Germany', 'GER', 'country', NULL, NULL),"
                "(%s, 'Mueller', 'MUE', 'player', %s, 'captain')",
                (country, player, country),
            )

            def ins(
                block: int,
                token: str,
                side: str,
                base_value: int,
                token_value: int,
                ts: int,
            ) -> None:
                tx = "0x" + f"{block:064x}"
                cur.execute(
                    "INSERT INTO events "
                    "(block_number, tx_hash, log_index, token_address, side, "
                    " trader_address, base_value, token_value, fee, ts) "
                    "VALUES (%s, %s, 0, %s, %s, %s, %s, %s, 0, to_timestamp(%s))",
                    (block, tx, token, side, "0x" + "bb" * 20, base_value, token_value, ts),
                )

            # Country: rate=2 at T1 (10/5), rate=10 at T5 (50/5).
            ins(100, country, "buy", 10 * WEI, 5 * WEI, t1)
            ins(102, country, "buy", 50 * WEI, 5 * WEI, t5)
            # Player: 1.0 country/player at T2 (3/3), and 1.0 again at T6 (3/3).
            # Same NATIVE price both times — only the country→PITCH rate moves.
            ins(200, player, "buy", 3 * WEI, 3 * WEI, t2)
            ins(202, player, "buy", 3 * WEI, 3 * WEI, t6)
            conn.commit()
        return {
            "country": country,
            "player": player,
            "t2": t2,
            "t6": t6,
        }

    def test_unit_pitch_uses_historical_country_rate_not_latest(
        self, app, seeded_historical_rate_change
    ) -> None:
        """Regression: PITCH conversion MUST use the country rate at each
        player event's own timestamp, NOT the current/latest country rate.

        If the bug were «apply latest country rate to all historical events»,
        both player trade-points would equal 10.0 (flat) and the chart shape
        would be just country-mode times a constant. Correct historical-rate
        lookup yields 2.0 → 10.0 (rising).
        """

        addr = seeded_historical_rate_change["player"]
        resp_pitch = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m&unit=pitch")
        resp_country = app.test_client().get(f"/api/v1/tokens/{addr}/chart?tf=5m&unit=country")
        assert resp_pitch.status_code == 200
        assert resp_country.status_code == 200
        body_pitch = resp_pitch.get_json()
        body_country = resp_country.get_json()

        trade_pts_pitch = [p for p in body_pitch["points"] if p["type"] != "spot"]
        trade_pts_country = [p for p in body_country["points"] if p["type"] != "spot"]
        assert len(trade_pts_pitch) == 2
        assert len(trade_pts_country) == 2

        # Country-mode: both player trades at native price 1.0 (flat).
        assert trade_pts_country[0]["price"] == pytest.approx(1.0)
        assert trade_pts_country[1]["price"] == pytest.approx(1.0)

        # PITCH-mode: must be 2.0 then 10.0 — proving historical rates are
        # used per-event. If broken (latest-only), both would be 10.0.
        assert trade_pts_pitch[0]["price"] == pytest.approx(2.0)
        assert trade_pts_pitch[1]["price"] == pytest.approx(10.0)

        # Sanity: shape differs from country-mode * constant. Ratio of the
        # two PITCH prices (10.0 / 2.0 = 5.0) MUST NOT equal the ratio of the
        # two country-mode prices (1.0 / 1.0 = 1.0). A broken implementation
        # would have ratios match exactly.
        country_ratio = trade_pts_country[1]["price"] / trade_pts_country[0]["price"]
        pitch_ratio = trade_pts_pitch[1]["price"] / trade_pts_pitch[0]["price"]
        assert pitch_ratio != pytest.approx(country_ratio)

        # Candles: T2 (bucket A), T6 (bucket B) — distinct 5m buckets thanks
        # to the +1000s gap. Find the bucket that contains the T2 trade and
        # the one containing T6; their close prices must differ in PITCH-mode.
        t2 = seeded_historical_rate_change["t2"]
        t6 = seeded_historical_rate_change["t6"]
        bucket_t2 = (t2 // 300) * 300
        bucket_t6 = (t6 // 300) * 300
        candles_by_time = {c["time"]: c for c in body_pitch["candles"]}
        assert bucket_t2 in candles_by_time
        assert bucket_t6 in candles_by_time
        # The T2 candle's close should be 2.0 (1.0 country * 2 PITCH/country).
        # The T6 candle's close should be 10.0 (1.0 country * 10 PITCH/country).
        # Note: forward-fill may carry the prev close across gap buckets, but
        # the *trade* buckets themselves must reflect the converted prices.
        assert candles_by_time[bucket_t2]["close"] == pytest.approx(2.0)
        assert candles_by_time[bucket_t6]["close"] == pytest.approx(10.0)

    def test_unit_pitch_400_when_player_has_no_country_address(
        self, app, seeded_player_with_no_country_address
    ) -> None:
        resp = app.test_client().get(
            f"/api/v1/tokens/{seeded_player_with_no_country_address}/chart?unit=pitch"
        )
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["code"] == "validation.bad_request"

    def test_player_trade_before_country_history_is_skipped(
        self, app, seeded_player_traded_before_country
    ) -> None:
        addr = seeded_player_traded_before_country["player"]
        # unit=country: native — the player trade is visible.
        resp_country = app.test_client().get(f"/api/v1/tokens/{addr}/chart?unit=country")
        body_country = resp_country.get_json()
        trade_pts_native = [p for p in body_country["points"] if p["type"] != "spot"]
        assert len(trade_pts_native) == 1

        # unit=pitch: no country price available at T1 → trade is dropped.
        resp_pitch = app.test_client().get(f"/api/v1/tokens/{addr}/chart?unit=pitch")
        body_pitch = resp_pitch.get_json()
        trade_pts_pitch = [p for p in body_pitch["points"] if p["type"] != "spot"]
        assert trade_pts_pitch == []


class TestTrades:
    """spec §4.3 — `/trades` wraps in `{trades: {...}, wallets, totalTrades, myWallet}`."""

    def test_unknown_token_404(self, app) -> None:
        resp = app.test_client().get(
            "/api/v1/tokens/0x0000000000000000000000000000000000000000/trades"
        )
        assert resp.status_code == 404

    def test_empty_with_envelope(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["player"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/trades")
        assert resp.status_code == 200
        body = resp.get_json()
        # Outer envelope per spec §4.3.
        assert set(body.keys()) >= {"trades", "wallets", "totalTrades", "myWallet"}
        # Inner trades envelope per spec §1.5 pagination.
        assert body["trades"]["items"] == []
        assert body["trades"]["nextCursor"] is None
        assert body["trades"]["limit"] == 100
        assert body["wallets"] == []
        assert body["totalTrades"] == 0
        # Premium not wired → myWallet stub.
        assert body["myWallet"] == {"configured": False}

    def test_bad_cursor(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["player"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/trades?cursor=!!!not-base64!!!")
        assert resp.status_code == 400

    def test_bad_limit(self, app, seeded_tokens) -> None:
        addr = seeded_tokens["player"]
        resp = app.test_client().get(f"/api/v1/tokens/{addr}/trades?limit=99999")
        assert resp.status_code == 400
