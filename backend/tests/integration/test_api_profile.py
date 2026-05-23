"""Integration tests for ``GET /api/v1/profile`` (api-spec §6.1)."""

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
_CONTRACT = "0x" + "ee" * 20


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
            _insert_event(
                200 + i, 0, _PLAYER, _WALLET, "buy", 10**18, 10**18, 10**16
            )

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
        assert (
            body2["trades"]["items"][0]["timestamp"]
            < body["trades"]["items"][-1]["timestamp"]
        )

    def test_bad_cursor_returns_400(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with _premium(has_access=True):
            resp = client.get("/api/v1/profile?tradesCursor=!!!bogus!!!")
        assert resp.status_code == 400
        assert resp.get_json()["code"] == "validation.bad_request"
