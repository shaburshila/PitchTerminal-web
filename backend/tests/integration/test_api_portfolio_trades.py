"""Integration tests for ``GET /api/v1/portfolio/trades`` (per-token history).

Covers the premium gate, trader+token filtering, cursor pagination, token
validation (missing → 400, unknown → 404), and the trade-item field shape
(reused from ``/api/v1/profile``).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from unittest.mock import patch

import psycopg
import pytest

from app import create_app
from shared import access as access_mod
from shared import jwt as jwt_mod

_COUNTRY = "0x" + "11" * 20
_PLAYER = "0x" + "22" * 20
_WALLET = "0x" + "ab" * 20
_OTHER = "0x" + "cd" * 20
_CONTRACT = "0x" + "ee" * 20
_UNKNOWN_TOKEN = "0x" + "99" * 20


@contextmanager
def _premium(*, has_access: bool):
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
    """Seed a country + a player + market_state for both."""

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Country', 'CTY', 'country', NULL, NULL)",
                (_COUNTRY,),
            )
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Player', 'PLR', 'player', %s, 'captain')",
                (_PLAYER, _COUNTRY),
            )
            # Country: 1 PITCH/token. Player: 2 country/token -> 2 PITCH/token.
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, %s, %s, %s)",
                (_COUNTRY, 0, 1 * 10**18, 100 * 10**18),
            )
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, %s, %s, %s)",
                (_PLAYER, 2 * 10**18, 2 * 10**18, 100 * 10**18),
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
    tx_hash = "0x" + f"{block:062x}{log_index:02x}"
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
        resp = app.test_client().get(f"/api/v1/portfolio/trades?token={_COUNTRY}")
        assert resp.status_code == 401
        assert resp.get_json()["code"] == "auth.unauthenticated"

    def test_authed_but_no_premium_returns_402(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=False):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}")
        assert resp.status_code == 402
        assert resp.get_json()["code"] == "access.payment_required"


class TestTokenValidation:
    def test_missing_token_returns_400(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio/trades")
        assert resp.status_code == 400
        assert resp.get_json()["code"] == "validation.bad_request"

    def test_unknown_token_returns_404(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_UNKNOWN_TOKEN}")
        assert resp.status_code == 404
        assert resp.get_json()["code"] == "tokens.unknown"

    def test_malformed_token_returns_404(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio/trades?token=not-an-address")
        assert resp.status_code == 404
        assert resp.get_json()["code"] == "tokens.unknown"

    def test_bad_limit_returns_400(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}&limit=0")
        assert resp.status_code == 400
        assert resp.get_json()["code"] == "validation.bad_request"

    def test_limit_over_max_returns_400(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}&limit=101")
        assert resp.status_code == 400

    def test_bad_cursor_returns_400(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}&cursor=!!!bad!!!")
        assert resp.status_code == 400
        assert resp.get_json()["code"] == "validation.bad_request"


class TestEmpty:
    def test_no_trades_returns_empty(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}")
        assert resp.status_code == 200
        assert resp.get_json() == {"items": [], "nextCursor": None, "limit": 50}


class TestFiltering:
    def test_filters_by_trader_and_token(self, app) -> None:
        # Wallet trades on CTY (2 trades) and PLR (1 trade).
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 5 * 10**18, 5 * 10**18, 0)
        _insert_event(101, 0, _COUNTRY, _WALLET, "sell", 2 * 10**18, 2 * 10**18, 0)
        _insert_event(102, 0, _PLAYER, _WALLET, "buy", 4 * 10**18, 2 * 10**18, 0)
        # Other wallet on CTY — must NOT appear.
        _insert_event(103, 0, _COUNTRY, _OTHER, "buy", 9 * 10**18, 9 * 10**18, 0)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}")
        assert resp.status_code == 200
        body = resp.get_json()
        # Only the wallet's two CTY trades.
        assert len(body["items"]) == 2
        assert {it["type"] for it in body["items"]} == {"buy", "sell"}
        assert all(it["kind"] == "country" for it in body["items"])
        assert all(it["symbol"] == "CTY" for it in body["items"])
        # DESC order: block 101 (sell) before block 100 (buy).
        assert body["items"][0]["type"] == "sell"
        assert body["items"][1]["type"] == "buy"

    def test_player_trades_returned_with_player_meta(self, app) -> None:
        _insert_event(100, 0, _PLAYER, _WALLET, "buy", 4 * 10**18, 2 * 10**18, 0)
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_PLAYER}")
        body = resp.get_json()
        assert len(body["items"]) == 1
        item = body["items"][0]
        assert item["kind"] == "player"
        assert item["symbol"] == "PLR"


class TestFieldShape:
    def test_item_has_full_field_set(self, app) -> None:
        # Country buy: 10 PITCH gross, 1 PITCH fee, 5 tokens.
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10 * 10**18, 5 * 10**18, 1 * 10**18)
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}")
        item = resp.get_json()["items"][0]
        assert set(item.keys()) == {
            "symbol",
            "kind",
            "type",
            "price",
            "marketPrice",
            "amount",
            "valuePitch",
            "feePitch",
            "timestamp",
            "tx",
        }
        # price = base/token = 10/5 = 2. marketPrice (fee-excluded buy) = 9/5 = 1.8.
        assert item["price"] == pytest.approx(2.0)
        assert item["marketPrice"] == pytest.approx(1.8)
        assert item["amount"] == pytest.approx(5.0)
        # country_price_pitch = 1 (country base IS PITCH) → valuePitch = base*1 = 10.
        assert item["valuePitch"] == pytest.approx(10.0)
        assert item["timestamp"] == 1_700_000_000 + 100


class TestPagination:
    def test_cursor_pages_through_all(self, app) -> None:
        # 5 wallet trades on CTY across distinct blocks.
        for i in range(5):
            _insert_event(200 + i, 0, _COUNTRY, _WALLET, "buy", 10**18, 10**18, 0)
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}&limit=2")
            body = resp.get_json()
            assert len(body["items"]) == 2
            assert body["limit"] == 2
            assert body["nextCursor"] is not None
            # Follow the cursor.
            resp2 = client.get(
                f"/api/v1/portfolio/trades?token={_COUNTRY}&limit=2&cursor={body['nextCursor']}"
            )
            body2 = resp2.get_json()
            assert len(body2["items"]) == 2
            assert body2["nextCursor"] is not None
            # Older page: its first item's timestamp < first page's last item.
            assert body2["items"][0]["timestamp"] < body["items"][-1]["timestamp"]
            # Final page: 1 remaining, no further cursor.
            resp3 = client.get(
                f"/api/v1/portfolio/trades?token={_COUNTRY}&limit=2&cursor={body2['nextCursor']}"
            )
            body3 = resp3.get_json()
        assert len(body3["items"]) == 1
        assert body3["nextCursor"] is None

    def test_default_limit_is_50(self, app) -> None:
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10**18, 10**18, 0)
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}")
        assert resp.get_json()["limit"] == 50

    def test_log_index_tiebreak_within_block(self, app) -> None:
        # Same block, two log indices — DESC ordering must put higher log first
        # and the cursor must walk to the lower one.
        _insert_event(300, 0, _COUNTRY, _WALLET, "buy", 10**18, 10**18, 0)
        _insert_event(300, 1, _COUNTRY, _WALLET, "sell", 10**18, 10**18, 0)
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get(f"/api/v1/portfolio/trades?token={_COUNTRY}&limit=1")
            body = resp.get_json()
            assert body["items"][0]["type"] == "sell"  # log_index 1 first (DESC)
            resp2 = client.get(
                f"/api/v1/portfolio/trades?token={_COUNTRY}&limit=1&cursor={body['nextCursor']}"
            )
            body2 = resp2.get_json()
        assert body2["items"][0]["type"] == "buy"  # log_index 0 next
        assert body2["nextCursor"] is None
