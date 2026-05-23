"""Integration tests for ``GET /api/v1/access`` (api-spec §5.1, B0.11)."""

from __future__ import annotations

from typing import Any
from unittest.mock import patch

import pytest

from app import create_app
from shared import access as access_mod
from shared import jwt as jwt_mod

_WALLET = "0x" + "ab" * 20
_CONTRACT = "0x" + "11" * 20


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture(autouse=True)
def _reset_access_cache() -> Any:
    access_mod.reset_cache()
    yield
    access_mod.reset_cache()


def _set_session(client, address: str) -> None:
    token = jwt_mod.encode(address)
    client.set_cookie("pt_session", token, domain="localhost")


# ─── Auth ────────────────────────────────────────────────────────────────────


class TestAuth:
    def test_no_cookie_returns_401(self, app) -> None:
        resp = app.test_client().get("/api/v1/access")
        assert resp.status_code == 401
        assert resp.get_json()["code"] == "auth.unauthenticated"


# ─── Mock mode (no ACCESS_CONTRACT) ─────────────────────────────────────────


class TestMockMode:
    """Default test env has no ACCESS_CONTRACT — endpoint short-circuits."""

    def test_no_contract_returns_false_none(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        resp = client.get("/api/v1/access")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["address"] == _WALLET
        assert body["hasAccess"] is False
        assert body["source"] == "none"
        assert "cachedAt" in body and "checkedAt" in body


# ─── RPC behaviour (ACCESS_CONTRACT set, _rpc_has_access mocked) ────────────


class TestWithContract:
    """Patch ``_rpc_has_access`` so we don't hit the real Base RPC."""

    def test_true_path(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=True),
        ):
            resp = client.get("/api/v1/access")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["hasAccess"] is True
        assert body["source"] == "paid"
        assert body["address"] == _WALLET

    def test_false_path(self, app) -> None:
        client = app.test_client()
        _set_session(client, _WALLET)
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=False),
        ):
            resp = client.get("/api/v1/access")
        body = resp.get_json()
        assert body["hasAccess"] is False
        assert body["source"] == "none"

    def test_fresh_bypasses_cache(self, app) -> None:
        """``fresh=1`` must force another RPC call even if cache says yes."""

        client = app.test_client()
        _set_session(client, _WALLET)
        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=True) as rpc,
        ):
            client.get("/api/v1/access")  # warm cache
            client.get("/api/v1/access?fresh=1")  # must call RPC again
        assert rpc.call_count == 2


# ─── Rate-limit on fresh=1 ──────────────────────────────────────────────────


class TestRateLimit:
    """5/min/address on ``?fresh=1`` per api-spec §11."""

    def test_sixth_fresh_request_is_429(self) -> None:
        # Need a fresh app instance with rate-limiting ENABLED.
        app = create_app(test_overrides={"RATELIMIT_ENABLED": True})
        client = app.test_client()
        _set_session(client, _WALLET)

        with (
            patch.object(access_mod, "_get_contract_address", return_value=_CONTRACT),
            patch.object(access_mod, "_rpc_has_access", return_value=False),
        ):
            statuses = []
            for _ in range(6):
                r = client.get("/api/v1/access?fresh=1")
                statuses.append(r.status_code)

        assert statuses[:5] == [200] * 5
        assert statuses[5] == 429
