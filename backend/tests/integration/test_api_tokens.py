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

    def test_returns_192_when_seeded(self, app, seeded_tokens) -> None:
        resp = app.test_client().get("/api/v1/tokens")
        assert resp.status_code == 200
        body = resp.get_json()
        assert len(body["players"]) == 144
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
