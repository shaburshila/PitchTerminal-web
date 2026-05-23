"""Integration tests for ``GET /api/v1/health`` (api-spec §9.1).

Talks to the real Postgres pool. RPC is stubbed via the ``W3_FACTORY``
app-config hook so tests don't depend on Base's mainnet RPC being reachable.
"""

from __future__ import annotations

from typing import Any

import pytest

from app import create_app


class _FakeW3:
    """Just enough to satisfy ``w3.eth.block_number``."""

    class _Eth:
        block_number = 12345678

    eth = _Eth()


class _BrokenW3:
    """RPC client that raises on any access."""

    @property
    def eth(self) -> Any:
        raise RuntimeError("RPC down")


@pytest.fixture()
def app_ok():
    app = create_app(test_overrides={"RATELIMIT_ENABLED": False, "W3_FACTORY": _FakeW3})
    yield app


@pytest.fixture()
def app_rpc_down():
    app = create_app(test_overrides={"RATELIMIT_ENABLED": False, "W3_FACTORY": _BrokenW3})
    yield app


class TestHealthOk:
    """Spec §9.1 happy path."""

    def test_returns_200_with_components_block(self, app_ok) -> None:
        resp = app_ok.test_client().get("/api/v1/health")
        assert resp.status_code == 200
        # Health is the only endpoint that is plain JSON even on 503.
        assert resp.mimetype == "application/json"
        body = resp.get_json()
        assert body["status"] == "ok"
        components = body["components"]
        # api/db must be ok; rpc=ok with the fake; worker may be unknown
        # without app_state.last_price_update (worker hasn't ticked yet).
        assert components["api"] == "ok"
        assert components["db"] in {"ok", "slow"}
        assert components["rpc"] == "ok"
        assert components["worker"] in {"ok", "stale", "unknown"}
        assert "version" in body
        assert isinstance(body["checkedAt"], int)

    def test_includes_data_block_on_ok(self, app_ok) -> None:
        body = app_ok.test_client().get("/api/v1/health").get_json()
        # data block surfaces on the happy path only (per spec §9.1).
        assert "data" in body
        data = body["data"]
        assert set(data.keys()) >= {"lastPriceUpdate", "lastEventBlock", "freshSec", "stale"}


class TestHealthDegraded:
    """Spec §9.1 degraded path — only db=down triggers 503."""

    def test_rpc_down_does_not_503(self, app_rpc_down) -> None:
        # Per spec §9.1: rpc=stale does NOT influence root status. Only db=down
        # causes 503. So an RPC outage with healthy DB stays at 200 with
        # rpc="stale" inside components.
        resp = app_rpc_down.test_client().get("/api/v1/health")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["status"] == "ok"
        assert body["components"]["rpc"] == "stale"
        assert body["components"]["db"] in {"ok", "slow"}
