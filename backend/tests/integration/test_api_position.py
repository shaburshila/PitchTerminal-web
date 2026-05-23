"""Integration tests for ``GET /api/v1/tokens/{token}/position`` (api-spec §4.4)."""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest

from app import create_app
from shared import jwt as jwt_mod

# Test fixtures: a self-sufficient country token and a player under it.
_COUNTRY = "0x" + "11" * 20
_PLAYER = "0x" + "22" * 20
_WALLET = "0x" + "ab" * 20
_OTHER = "0x" + "cd" * 20


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture(autouse=True)
def _seed_token(_clean_tokens_table) -> Iterator[None]:
    """Insert a tiny token graph + market_state row for the player.

    Depends on the autouse ``_clean_tokens_table`` from conftest so the
    TRUNCATE runs *before* this seed (rather than racing with it).
    """

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
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, %s, %s, %s)",
                (_PLAYER, 0, 2 * 10**18, 100 * 10**18),
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
    """Auth + premium gate (using the stub) — covers 401 and 402 branches."""

    def test_no_cookie_returns_401(self, app) -> None:
        resp = app.test_client().get(f"/api/v1/tokens/{_PLAYER}/position")
        assert resp.status_code == 401
        assert resp.get_json()["code"] == "auth.unauthenticated"

    def test_authed_but_no_premium_returns_402(self, app, monkeypatch) -> None:
        monkeypatch.delenv("PREMIUM_STUB_BYPASS", raising=False)
        client = app.test_client()
        _set_session(client, _WALLET)
        resp = client.get(f"/api/v1/tokens/{_PLAYER}/position")
        assert resp.status_code == 402
        body = resp.get_json()
        assert body["code"] == "access.payment_required"

    def test_premium_bypass_returns_200(self, app, monkeypatch) -> None:
        monkeypatch.setenv("PREMIUM_STUB_BYPASS", "1")
        client = app.test_client()
        _set_session(client, _WALLET)
        resp = client.get(f"/api/v1/tokens/{_PLAYER}/position")
        assert resp.status_code == 200


class TestEnvelope:
    """Shape of the response under different activity states."""

    def test_unknown_token_404(self, app, monkeypatch) -> None:
        monkeypatch.setenv("PREMIUM_STUB_BYPASS", "1")
        client = app.test_client()
        _set_session(client, _WALLET)
        unknown = "0x" + "00" * 20
        resp = client.get(f"/api/v1/tokens/{unknown}/position")
        assert resp.status_code == 404
        assert resp.get_json()["code"] == "tokens.unknown"

    def test_no_activity_returns_inactive_block(self, app, monkeypatch) -> None:
        monkeypatch.setenv("PREMIUM_STUB_BYPASS", "1")
        client = app.test_client()
        _set_session(client, _WALLET)
        resp = client.get(f"/api/v1/tokens/{_PLAYER}/position")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body == {
            "configured": True,
            "address": _WALLET,
            "hasActivity": False,
        }

    def test_with_activity_returns_full_block(self, app, monkeypatch) -> None:
        monkeypatch.setenv("PREMIUM_STUB_BYPASS", "1")
        # Buy 1 token for 1 base (with 0.05 fee), sell 0.5 tokens for 0.6 base.
        _insert_event(100, 0, _PLAYER, _WALLET, "buy", 10**18, 10**18, 5 * 10**16)
        _insert_event(101, 0, _PLAYER, _WALLET, "sell", 6 * 10**17, 5 * 10**17, 3 * 10**16)
        # Another trader buys — affects holders/rank but not myWallet PnL.
        _insert_event(102, 0, _PLAYER, _OTHER, "buy", 2 * 10**18, 2 * 10**18, 10**17)

        client = app.test_client()
        _set_session(client, _WALLET)
        resp = client.get(f"/api/v1/tokens/{_PLAYER}/position")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["configured"] is True
        assert body["address"] == _WALLET
        assert body["hasActivity"] is True
        assert body["buys"] == 1
        assert body["sells"] == 1
        # position = 1 - 0.5 = 0.5
        assert body["position"] == pytest.approx(0.5, abs=1e-4)
        # currentPrice = 2 (set in fixture)
        assert body["currentPrice"] == pytest.approx(2.0)
        # holders includes both wallets with net > 0
        assert body["holdersCount"] == 2
        assert body["rank"] in {1, 2}
        # ownershipPct = 0.5 / 100 * 100 = 0.5%
        assert body["ownershipPct"] == pytest.approx(0.5)
        # firstTradeTs present (non-zero from to_timestamp seed)
        assert body["firstTradeTs"] is not None
