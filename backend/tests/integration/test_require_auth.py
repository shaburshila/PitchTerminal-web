"""Integration: ``@require_auth`` decorator behaviour.

We register an ad-hoc protected route on a freshly-built app and exercise
the cookie-handling paths.
"""

from __future__ import annotations

import pytest
from flask import g, jsonify

from app import create_app
from app.deps import require_auth
from shared import jwt as jwt_mod


def _make_protected_app():
    app = create_app(test_overrides={"RATELIMIT_ENABLED": False})

    @app.get("/_test/me")
    @require_auth
    def _me():  # type: ignore[no-untyped-def]
        return jsonify({"address": g.address})

    return app


@pytest.fixture()
def app():
    return _make_protected_app()


def _problem(resp):
    assert resp.headers["Content-Type"].startswith("application/problem+json")
    return resp.get_json()


def test_missing_cookie_returns_401(app) -> None:
    resp = app.test_client().get("/_test/me")
    assert resp.status_code == 401
    assert _problem(resp)["code"] == "auth.unauthenticated"


def test_valid_cookie_returns_address(app) -> None:
    addr = "0x" + "ab" * 20
    token = jwt_mod.encode(addr)
    client = app.test_client()
    client.set_cookie("pt_session", token, domain="localhost")
    resp = client.get("/_test/me")
    assert resp.status_code == 200
    assert resp.get_json() == {"address": addr}


def test_expired_cookie_returns_401(app) -> None:
    addr = "0x" + "cd" * 20
    token = jwt_mod.encode(addr, ttl_seconds=-10)
    client = app.test_client()
    client.set_cookie("pt_session", token, domain="localhost")
    resp = client.get("/_test/me")
    assert resp.status_code == 401
    assert _problem(resp)["code"] == "auth.jwt.expired"


def test_garbage_cookie_returns_401(app) -> None:
    client = app.test_client()
    client.set_cookie("pt_session", "not-a-jwt", domain="localhost")
    resp = client.get("/_test/me")
    assert resp.status_code == 401
    assert _problem(resp)["code"] == "auth.unauthenticated"
