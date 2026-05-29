"""Integration tests for ``GET /api/v1/config``."""

from __future__ import annotations

import pytest

from app import create_app
from app.routes import config as config_routes


@pytest.fixture(autouse=True)
def _reset_cache() -> None:
    """Each test sees a cold cache — otherwise tests would alias each other."""

    config_routes.invalidate_cache()


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


class TestConfigShape:
    def test_200_with_full_shape(self, app) -> None:
        resp = app.test_client().get("/api/v1/config")
        assert resp.status_code == 200
        body = resp.get_json()
        # Required top-level keys per api-spec §3.2.
        for key in (
            "version",
            "chainId",
            "chainName",
            "contracts",
            "accessPriceWei",
            "buyerDiscountBps",
            "referralBps",
            "walletConnect",
            "limits",
            "siwe",
            "freshnessThresholdSec",
        ):
            assert key in body, f"missing key: {key}"
        assert body["chainId"] == 8453
        assert body["chainName"] == "Base"
        # `version` is git SHA (production) or "dev" (local) — string either way.
        assert isinstance(body["version"], str) and body["version"]

    def test_defaults_when_no_snapshot(self, app) -> None:
        # The integration conftest truncates `tokens` (not app_state), so
        # access_config may or may not exist; default values are stringy wei.
        resp = app.test_client().get("/api/v1/config")
        body = resp.get_json()
        # accessPriceWei is always a string per api-spec §1.2 (wei → string).
        assert isinstance(body["accessPriceWei"], str)
        assert isinstance(body["buyerDiscountBps"], int)
        assert isinstance(body["referralBps"], int)

    def test_addresses_lowercase(self, app) -> None:
        resp = app.test_client().get("/api/v1/config")
        body = resp.get_json()
        for _name, addr in body["contracts"].items():
            if addr:  # may be empty string if env var not set
                assert addr == addr.lower()

    def test_icon_contract_keys_present(self, app) -> None:
        # Icon venue addresses are exposed so the frontend can route icon
        # trades. Values may be empty strings if the env vars aren't set in
        # the test environment — we only assert the keys exist.
        resp = app.test_client().get("/api/v1/config")
        contracts = resp.get_json()["contracts"]
        for key in ("iconHook", "iconRouter", "iconLimitOrderExecutor"):
            assert key in contracts, f"missing contracts.{key}"


class TestConfigFresh:
    def test_fresh_bypasses_cache(self, app) -> None:
        # First call populates cache.
        client = app.test_client()
        r1 = client.get("/api/v1/config")
        assert r1.status_code == 200
        # Fresh call should also succeed.
        r2 = client.get("/api/v1/config?fresh=1")
        assert r2.status_code == 200
        # Same shape.
        assert r1.get_json().keys() == r2.get_json().keys()


class TestConfigCache:
    def test_cache_returns_same_payload(self, app) -> None:
        client = app.test_client()
        r1 = client.get("/api/v1/config")
        r2 = client.get("/api/v1/config")
        assert r1.get_json() == r2.get_json()
