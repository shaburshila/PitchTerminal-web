"""Integration tests for ``/api/v1/orders`` (api-spec §7 + B2.1)."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from unittest.mock import patch

import psycopg
import pytest
from eth_account import Account
from eth_account.messages import encode_typed_data
from psycopg.rows import dict_row

from app import create_app
from app.deps import SESSION_COOKIE
from shared import access as access_mod
from shared import jwt as jwt_mod
from shared import orders as orders_mod

# ─── Fixed test addresses / keys ────────────────────────────────────────────

# Deterministic test EOA: private key + derived address.
_TEST_PK = "0x" + "11" * 32
_TEST_ACCOUNT = Account.from_key(_TEST_PK)
_TEST_ADDR: str = _TEST_ACCOUNT.address.lower()

_OTHER_PK = "0x" + "22" * 32
_OTHER_ACCOUNT = Account.from_key(_OTHER_PK)
_OTHER_ADDR: str = _OTHER_ACCOUNT.address.lower()

_COUNTRY_ADDR = "0x" + "aa" * 20
_PLAYER_ADDR = "0x" + "bb" * 20
_PITCH_ADDR = "0x" + "cc" * 20
_OTHER_TOKEN = "0x" + "dd" * 20
_EXECUTOR_ADDR = "0x" + "ee" * 20
_ACCESS_CONTRACT = "0x" + "ff" * 20

# Keeper shared secret used in these tests.
_KEEPER_TOKEN = "test-keeper-secret-do-not-use-in-prod"


@contextmanager
def _premium(*, has_access: bool):
    """Force the premium gate to a constant value without touching RPC."""

    access_mod.reset_cache()
    with (
        patch.object(access_mod, "_get_contract_address", return_value=_ACCESS_CONTRACT),
        patch.object(access_mod, "_rpc_has_access", return_value=has_access),
    ):
        try:
            yield
        finally:
            access_mod.reset_cache()


@contextmanager
def _configured_executor():
    """Pin :data:`shared.config.config.executor_contract` for signature verify."""

    from dataclasses import replace

    patched = replace(
        orders_mod.config,
        executor_contract=_EXECUTOR_ADDR,
        pitch_token=_PITCH_ADDR,
    )
    with patch.object(orders_mod, "config", patched):
        yield


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture(autouse=True)
def _seed_tokens(_clean_tokens_table) -> Iterator[None]:
    """Seed: 1 country (PITCH-quote) + 1 player (country-quote)."""

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL)",
                (_COUNTRY_ADDR,),
            )
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Pele', 'PEL', 'player', %s, 'captain')",
                (_PLAYER_ADDR, _COUNTRY_ADDR),
            )
            # Mid-market prices: player @ 5 country-wei, country @ 7 PITCH-wei.
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, 0, %s, 100)",
                (_COUNTRY_ADDR, 7 * 10**18),
            )
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch, supply) "
                "VALUES (%s, %s, %s, 50)",
                (_PLAYER_ADDR, 5 * 10**18, 35 * 10**18),
            )
        conn.commit()
    yield


@pytest.fixture(autouse=True)
def _clean_orders() -> Iterator[None]:
    """Wipe limit_orders + user_settings between tests."""

    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM limit_orders")
            cur.execute("DELETE FROM user_settings")
        conn.commit()
    yield


@pytest.fixture(autouse=True)
def _keeper_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEEPER_AUTH_TOKEN", _KEEPER_TOKEN)


@pytest.fixture(autouse=True)
def _no_network_for_eip1271(monkeypatch: pytest.MonkeyPatch) -> None:
    """Stop verify_order_signature from hitting a real RPC for EIP-1271 fallback.

    All tests use EOAs — ECDSA recovery is sufficient. We disable the on-chain
    isValidSignature path to keep the suite hermetic + fast.
    """

    from shared import eth as eth_mod

    def _fail(*_a: object, **_kw: object) -> None:
        raise RuntimeError("network disabled in tests")

    monkeypatch.setattr(eth_mod, "get_w3", _fail)


# ─── Helpers ────────────────────────────────────────────────────────────────


def _auth_client(app, address: str = _TEST_ADDR):
    client = app.test_client()
    token = jwt_mod.encode(address)
    client.set_cookie(SESSION_COOKIE, token, domain="localhost")
    return client


def _domain() -> dict[str, Any]:
    return {
        "name": orders_mod.EIP712_DOMAIN_NAME,
        "version": orders_mod.EIP712_DOMAIN_VERSION,
        "chainId": orders_mod.BASE_CHAIN_ID,
        "verifyingContract": _EXECUTOR_ADDR,
    }


def _types() -> dict[str, Any]:
    return {"Order": orders_mod.ORDER_TYPE_FIELDS}


def _make_order(
    *,
    owner: str = _TEST_ADDR,
    token: str = _PLAYER_ADDR,
    quote: str = _COUNTRY_ADDR,
    venue: int = 0,  # 0=player, 1=country
    side: int = 0,  # 0=limit-buy, 1=take-profit
    target_price: int = 4 * 10**18,  # below current 5 ⇒ limit-buy unmet
    amount_in: int = 1 * 10**18,
    slippage_bps: int = 100,
    expiry: int = 0,
    nonce: str | None = None,
) -> dict[str, Any]:
    if nonce is None:
        nonce = "0x" + ("ab" * 32)
    return {
        "owner": owner,
        "token": token,
        "quoteToken": quote,
        "venue": venue,
        "side": side,
        "targetPrice": str(target_price),
        "amountIn": str(amount_in),
        "slippageBps": slippage_bps,
        "expiry": expiry,
        "nonce": nonce,
    }


def _sign_order(account, order: dict[str, Any]) -> str:
    """Produce a real EIP-712 signature for ``order`` with ``account``."""

    msg = {
        "owner": order["owner"],
        "token": order["token"],
        "quoteToken": order["quoteToken"],
        "venue": int(order["venue"]),
        "side": int(order["side"]),
        "targetPrice": int(order["targetPrice"]),
        "amountIn": int(order["amountIn"]),
        "slippageBps": int(order["slippageBps"]),
        "expiry": int(order["expiry"]),
        "nonce": int(order["nonce"], 16),
    }
    signable = encode_typed_data(_domain(), _types(), msg)
    signed = account.sign_message(signable)
    raw = bytes(signed.signature)
    return "0x" + raw.hex()


def _post(client, order: dict[str, Any], signature: str) -> Any:
    return client.post(
        "/api/v1/orders",
        json={"order": order, "signature": signature},
    )


# ─── Tests ──────────────────────────────────────────────────────────────────


class TestAccessControl:
    def test_no_cookie_returns_401(self, app) -> None:
        with _configured_executor():
            resp = app.test_client().get("/api/v1/orders")
        assert resp.status_code == 401
        assert resp.get_json()["code"] == "auth.unauthenticated"

    def test_no_premium_returns_402(self, app) -> None:
        client = _auth_client(app)
        with _premium(has_access=False), _configured_executor():
            resp = client.get("/api/v1/orders")
        assert resp.status_code == 402
        assert resp.get_json()["code"] == "access.payment_required"


class TestCreateOrder:
    def test_happy_path_inserts_row(self, app) -> None:
        client = _auth_client(app)
        order = _make_order()
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, sig)
        assert resp.status_code == 200, resp.get_json()
        body = resp.get_json()
        assert body["owner"] == _TEST_ADDR
        assert body["status"] == "pending"
        assert body["venue"] == "player"
        assert body["side"] == "limit-buy"
        assert body["targetPrice"] == str(order["targetPrice"])

        # Row really landed.
        with (
            psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
            conn.cursor() as cur,
        ):
            cur.execute(
                "SELECT count(*) AS c FROM limit_orders WHERE owner_address = %s", (_TEST_ADDR,)
            )
            row = cur.fetchone()
            assert row is not None and int(row["c"]) == 1

    def test_invalid_signature_returns_422(self, app) -> None:
        client = _auth_client(app)
        order = _make_order()
        # Sign with a *different* key → recovery yields wrong address.
        with _configured_executor():
            bad_sig = _sign_order(_OTHER_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, bad_sig)
        assert resp.status_code == 422
        assert resp.get_json()["code"] == "orders.invalid_signature"

    def test_bad_quote_token_returns_422(self, app) -> None:
        client = _auth_client(app)
        # venue=player but quoteToken is NOT the player's country_address.
        order = _make_order(quote=_OTHER_TOKEN)
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, sig)
        assert resp.status_code == 422
        assert resp.get_json()["code"] == "orders.bad_quote_token"

    def test_unknown_token_returns_404(self, app) -> None:
        client = _auth_client(app)
        order = _make_order(token=_OTHER_TOKEN)
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, sig)
        assert resp.status_code == 404
        assert resp.get_json()["code"] == "tokens.unknown"

    def test_owner_mismatch_returns_401(self, app) -> None:
        client = _auth_client(app, address=_OTHER_ADDR)
        order = _make_order()  # owner=_TEST_ADDR
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, sig)
        assert resp.status_code == 401

    def test_target_price_already_met_returns_422(self, app) -> None:
        client = _auth_client(app)
        # limit-buy with target ABOVE current price (5) ⇒ condition already met.
        order = _make_order(target_price=10 * 10**18)
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, sig)
        assert resp.status_code == 422
        assert resp.get_json()["code"] == "orders.bad_target_price"

    def test_slippage_too_high_returns_422(self, app) -> None:
        client = _auth_client(app)
        order = _make_order(slippage_bps=9999)  # > MAX_SLIPPAGE_BPS (1000)
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, sig)
        assert resp.status_code == 422
        assert resp.get_json()["code"] == "orders.slippage_too_high"

    def test_idempotent_same_payload_returns_200(self, app) -> None:
        client = _auth_client(app)
        order = _make_order()
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                r1 = _post(client, order, sig)
                r2 = _post(client, order, sig)
        assert r1.status_code == 200
        assert r2.status_code == 200
        assert r1.get_json()["id"] == r2.get_json()["id"]

    def test_duplicate_nonce_different_payload_returns_409(self, app) -> None:
        client = _auth_client(app)
        nonce = "0x" + ("cd" * 32)
        order_a = _make_order(nonce=nonce)
        order_b = _make_order(nonce=nonce, amount_in=2 * 10**18)
        with _configured_executor():
            sig_a = _sign_order(_TEST_ACCOUNT, order_a)
            sig_b = _sign_order(_TEST_ACCOUNT, order_b)
            with _premium(has_access=True):
                r1 = _post(client, order_a, sig_a)
                r2 = _post(client, order_b, sig_b)
        assert r1.status_code == 200
        assert r2.status_code == 409
        assert r2.get_json()["code"] == "orders.duplicate_nonce"


class TestListOrders:
    def test_returns_only_own_orders(self, app) -> None:
        # Create one order as _TEST_ADDR.
        client = _auth_client(app)
        order = _make_order()
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                _post(client, order, sig)

        # Now query as _OTHER_ADDR — should see nothing.
        other = _auth_client(app, address=_OTHER_ADDR)
        with _premium(has_access=True), _configured_executor():
            resp = other.get("/api/v1/orders")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["items"] == []
        assert body["armed"] is True

        # Original wallet sees its order.
        with _premium(has_access=True), _configured_executor():
            resp = client.get("/api/v1/orders")
        body = resp.get_json()
        assert len(body["items"]) == 1
        assert body["items"][0]["owner"] == _TEST_ADDR


class TestCancelOrder:
    def _create(self, app) -> str:
        client = _auth_client(app)
        order = _make_order()
        with _configured_executor():
            sig = _sign_order(_TEST_ACCOUNT, order)
            with _premium(has_access=True):
                resp = _post(client, order, sig)
        return resp.get_json()["id"]

    def test_cancel_own_pending_returns_204(self, app) -> None:
        oid = self._create(app)
        client = _auth_client(app)
        with _premium(has_access=True), _configured_executor():
            resp = client.delete(f"/api/v1/orders/{oid}")
        assert resp.status_code == 204
        # Status really flipped.
        with (
            psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
            conn.cursor() as cur,
        ):
            cur.execute("SELECT status FROM limit_orders WHERE id = %s", (int(oid),))
            row = cur.fetchone()
            assert row is not None and row["status"] == "cancelled"

    def test_cancel_someone_elses_returns_404(self, app) -> None:
        oid = self._create(app)
        other = _auth_client(app, address=_OTHER_ADDR)
        with _premium(has_access=True), _configured_executor():
            resp = other.delete(f"/api/v1/orders/{oid}")
        assert resp.status_code == 404
        assert resp.get_json()["code"] == "orders.not_found"

    def test_cancel_filled_returns_422(self, app) -> None:
        oid = self._create(app)
        # Manually promote to filled.
        with (
            psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
            conn.cursor() as cur,
        ):
            cur.execute("UPDATE limit_orders SET status='filled' WHERE id = %s", (int(oid),))
            conn.commit()
        client = _auth_client(app)
        with _premium(has_access=True), _configured_executor():
            resp = client.delete(f"/api/v1/orders/{oid}")
        assert resp.status_code == 422
        assert resp.get_json()["code"] == "orders.bad_state"

    def test_cancel_already_cancelled_is_idempotent(self, app) -> None:
        oid = self._create(app)
        client = _auth_client(app)
        with _premium(has_access=True), _configured_executor():
            r1 = client.delete(f"/api/v1/orders/{oid}")
            r2 = client.delete(f"/api/v1/orders/{oid}")
        assert r1.status_code == 204
        assert r2.status_code == 204


class TestArmedEndpoint:
    def _create_triggering_order(self, app) -> str:
        """Create an order whose price condition IS met (for the armed query).

        Bypasses the POST validation (which blocks already-met orders) by
        inserting straight into the DB.
        """

        nonce = "0x" + ("ef" * 32)
        with (
            psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
            conn.cursor() as cur,
        ):
            cur.execute(
                "INSERT INTO limit_orders ("
                "owner_address, token_address, quote_address, venue, side, "
                "target_price, amount_in, slippage_bps, expires_at, nonce, signature) "
                "VALUES (%s, %s, %s, 'player', 'limit-buy', %s, %s, 100, NULL, %s, %s) "
                "RETURNING id",
                (
                    _TEST_ADDR,
                    _PLAYER_ADDR,
                    _COUNTRY_ADDR,
                    10 * 10**18,  # target ABOVE market 5 ⇒ limit-buy triggers
                    1 * 10**18,
                    nonce,
                    b"\x00" * 65,
                ),
            )
            row = cur.fetchone()
            conn.commit()
        assert row is not None
        return str(row["id"])

    def test_armed_without_token_returns_401(self, app) -> None:
        resp = app.test_client().get("/api/v1/orders/armed")
        assert resp.status_code == 401
        assert resp.get_json()["code"] == "auth.unauthenticated"

    def test_armed_with_token_returns_triggering(self, app) -> None:
        self._create_triggering_order(app)
        resp = app.test_client().get(
            "/api/v1/orders/armed",
            headers={"X-Keeper-Token": _KEEPER_TOKEN},
        )
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["count"] == 1
        assert body["items"][0]["owner"] == _TEST_ADDR
        assert body["items"][0]["signature"].startswith("0x")
        assert "currentPrice" in body["items"][0]

    def test_armed_respects_user_settings(self, app) -> None:
        self._create_triggering_order(app)
        # Disarm via user_settings.
        with (
            psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
            conn.cursor() as cur,
        ):
            cur.execute(
                "INSERT INTO user_settings (owner_address, orders_armed) " "VALUES (%s, false)",
                (_TEST_ADDR,),
            )
            conn.commit()
        resp = app.test_client().get(
            "/api/v1/orders/armed",
            headers={"X-Keeper-Token": _KEEPER_TOKEN},
        )
        assert resp.status_code == 200
        assert resp.get_json()["count"] == 0


class TestDigestCrossCheck:
    """Cross-check: viem-style typed-data hash matches our compute_order_digest."""

    def test_digest_recovery_round_trip(self, app) -> None:
        order_dict = _make_order()
        order = orders_mod.OrderIn(**order_dict)
        digest = orders_mod.compute_order_digest(order, _EXECUTOR_ADDR, orders_mod.BASE_CHAIN_ID)
        assert isinstance(digest, bytes) and len(digest) == 32

        # Independent signing path: eth_account → recover → match owner.
        sig_hex = _sign_order(_TEST_ACCOUNT, order_dict)
        with _configured_executor():
            ok = orders_mod.verify_order_signature(
                order,
                bytes.fromhex(sig_hex[2:]),
                executor_address=_EXECUTOR_ADDR,
                allow_eip1271=False,
            )
        assert ok is True
