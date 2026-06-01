"""Integration: ``POST /api/v1/auth/logout``."""

from __future__ import annotations

import pytest

from app import create_app


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


def test_logout_returns_204_without_session(app) -> None:
    resp = app.test_client().post("/api/v1/auth/logout")
    assert resp.status_code == 204


def test_logout_clears_cookie(app) -> None:
    resp = app.test_client().post("/api/v1/auth/logout")
    cookie_header = resp.headers.get("Set-Cookie", "")
    assert "pt_session=" in cookie_header
    # Either Max-Age=0 or Expires in the past; we set Max-Age=0.
    assert "Max-Age=0" in cookie_header
    assert "HttpOnly" in cookie_header
    assert "SameSite=Lax" in cookie_header
    assert "Path=/" in cookie_header


def test_cookie_not_secure_when_disabled() -> None:
    # SESSION_COOKIE_SECURE off (local HTTP dev default) → no Secure attribute,
    # else the cookie wouldn't be sent over plain HTTP.
    app = create_app(test_overrides={"RATELIMIT_ENABLED": False, "SESSION_COOKIE_SECURE": False})
    resp = app.test_client().post("/api/v1/auth/logout")
    assert "Secure" not in resp.headers.get("Set-Cookie", "")


def test_cookie_secure_when_enabled() -> None:
    # Production (HTTPS) sets SESSION_COOKIE_SECURE=1 (docker-compose.prod.yml)
    # → the pt_session cookie carries the Secure attribute.
    app = create_app(test_overrides={"RATELIMIT_ENABLED": False, "SESSION_COOKIE_SECURE": True})
    resp = app.test_client().post("/api/v1/auth/logout")
    assert "Secure" in resp.headers.get("Set-Cookie", "")
