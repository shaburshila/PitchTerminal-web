"""Integration tests for ``GET /api/v1/portfolio`` (api-spec §6.2).

Covers auth/premium gates, the empty-portfolio shape, mixed country+player
positions, and PnL math (gain vs loss).
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
    """Seed a country + a player under it, plus market_state for both."""

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
            # Country: 1 PITCH per 1 country token. Player: 2 country per 1 player token
            # → 2 PITCH per 1 player token (via country→PITCH multiplication).
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
        resp = app.test_client().get("/api/v1/portfolio")
        assert resp.status_code == 401
        assert resp.get_json()["code"] == "auth.unauthenticated"

    def test_authed_but_no_premium_returns_402(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=False):
            resp = client.get("/api/v1/portfolio")
        assert resp.status_code == 402
        assert resp.get_json()["code"] == "access.payment_required"


class TestEmptyPortfolio:
    def test_no_trades_returns_empty_items(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio")
        assert resp.status_code == 200
        assert resp.get_json() == {"items": []}

    def test_fully_sold_out_position_excluded(self, app) -> None:
        # Buy 1, sell 1 — net = 0, so not in items.
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10**18, 10**18, 0)
        _insert_event(101, 0, _COUNTRY, _WALLET, "sell", 10**18, 10**18, 0)
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio")
        assert resp.status_code == 200
        assert resp.get_json() == {"items": []}


class TestMixedPositions:
    def test_country_and_player_positions_present(self, app) -> None:
        # Country: bought 5 for 5 PITCH, fee 0. Position = 5; avg entry 1 PITCH.
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 5 * 10**18, 5 * 10**18, 0)
        # Player: bought 2 for 4 country (2 per token). Position = 2.
        # Player avg entry country = 2; converted to PITCH via country price 1 → 2 PITCH.
        _insert_event(101, 0, _PLAYER, _WALLET, "buy", 4 * 10**18, 2 * 10**18, 0)
        # An unrelated wallet's trade must not appear.
        _insert_event(102, 0, _COUNTRY, _OTHER, "buy", 10**18, 10**18, 0)

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio")
        assert resp.status_code == 200
        body = resp.get_json()
        items_by_token = {it["token"]: it for it in body["items"]}
        assert set(items_by_token) == {_COUNTRY, _PLAYER}

        country = items_by_token[_COUNTRY]
        assert country["kind"] == "country"
        assert country["symbol"] == "CTY"
        assert country["balance"] == str(5 * 10**18)
        assert country["balanceDisplay"] == pytest.approx(5.0)
        # avg entry = 1 PITCH, current = 1 PITCH → value 5, pnl 0.
        assert country["avgEntryPitch"] == str(10**18)
        assert country["currentPricePitch"] == str(10**18)
        assert country["valuePitch"] == str(5 * 10**18)
        assert country["pnlPitch"] == "0"

        player = items_by_token[_PLAYER]
        assert player["kind"] == "player"
        # balance = 2 tokens
        assert player["balance"] == str(2 * 10**18)
        # avg entry country = 2 → in PITCH = 2 * 1 = 2. current = 2 PITCH.
        assert player["avgEntryPitch"] == str(2 * 10**18)
        assert player["currentPricePitch"] == str(2 * 10**18)
        # value = 2 * 2 = 4 PITCH; pnl = 0.
        assert player["valuePitch"] == str(4 * 10**18)
        assert player["pnlPitch"] == "0"


class TestPnlMath:
    def test_unrealized_gain_correct(self, app) -> None:
        # Country: bought 10 at 1 PITCH each → avg 1 PITCH.
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10 * 10**18, 10 * 10**18, 0)
        # Bump current price to 3 PITCH/token via market_state mutation.
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE market_state SET price_pitch = %s WHERE token_address = %s",
                    (3 * 10**18, _COUNTRY),
                )
            conn.commit()

        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio")
        assert resp.status_code == 200
        item = resp.get_json()["items"][0]
        assert item["token"] == _COUNTRY
        assert item["balance"] == str(10 * 10**18)
        assert item["avgEntryPitch"] == str(10**18)
        assert item["currentPricePitch"] == str(3 * 10**18)
        # value = 10 * 3 = 30 PITCH
        assert item["valuePitch"] == str(30 * 10**18)
        # pnl = 30 - 10 = 20 PITCH
        assert item["pnlPitch"] == str(20 * 10**18)

    def test_unrealized_loss_is_negative_wei_string(self, app) -> None:
        # Bought at 5 PITCH, current 1 PITCH → loss of 4 per token.
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 5 * 10**18, 10**18, 0)
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio")
        assert resp.status_code == 200
        item = resp.get_json()["items"][0]
        # Avg entry 5 PITCH, current 1 PITCH, position 1.
        # value = 1, pnl = 1 - 5 = -4.
        assert item["valuePitch"] == str(10**18)
        assert item["pnlPitch"] == str(-4 * 10**18)
        assert item["pnlPitchDisplay"] == pytest.approx(-4.0)


class TestSortOrder:
    def test_items_sorted_by_value_descending(self, app) -> None:
        # Smaller position first in events; result must put bigger first.
        _insert_event(100, 0, _COUNTRY, _WALLET, "buy", 10**18, 10**18, 0)  # value 1 PITCH
        _insert_event(101, 0, _PLAYER, _WALLET, "buy", 10 * 10**18, 5 * 10**18, 0)  # value 10
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/portfolio")
        items = resp.get_json()["items"]
        assert [it["token"] for it in items] == [_PLAYER, _COUNTRY]
