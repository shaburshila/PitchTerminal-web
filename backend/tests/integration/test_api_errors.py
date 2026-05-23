"""Integration tests for error handling — RFC 7807 + rate limits."""

from __future__ import annotations

import pytest

from app import create_app


@pytest.fixture()
def app_no_limit():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture()
def app_with_limit():
    # Limits ON: we'll test that /config?fresh=1 throttles correctly.
    return create_app(test_overrides={"RATELIMIT_ENABLED": True})


class TestUnknownRoute:
    def test_404_problem_json(self, app_no_limit) -> None:
        resp = app_no_limit.test_client().get("/api/v1/this-does-not-exist")
        assert resp.status_code == 404
        assert resp.mimetype == "application/problem+json"
        body = resp.get_json()
        assert "code" in body
        assert body["status"] == 404


class TestRateLimit:
    def test_fresh_config_throttles_with_retry_after(self, app_with_limit) -> None:
        """``/config?fresh=1`` has a 10/min/IP limit; the 11th hit must 429
        with a ``Retry-After`` header in problem+json."""

        client = app_with_limit.test_client()
        # First 10 are fine.
        for _ in range(10):
            r = client.get("/api/v1/config?fresh=1")
            assert r.status_code == 200, f"early 429 at iteration: {r.status_code}"
        # 11th must be throttled.
        r = client.get("/api/v1/config?fresh=1")
        assert r.status_code == 429
        assert r.mimetype == "application/problem+json"
        body = r.get_json()
        assert body["code"] == "rate_limit.exceeded"
        assert "Retry-After" in r.headers
