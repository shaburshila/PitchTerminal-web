"""Integration tests for ``/api/v1/ref/*`` (api-spec §5.2)."""

from __future__ import annotations

import os
from collections.abc import Iterator

import psycopg
import pytest

from app import create_app
from app.deps import SESSION_COOKIE
from shared import jwt as jwt_mod


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture(autouse=True)
def _clean_referral_codes() -> Iterator[None]:
    """Truncate ``referral_codes`` before each test."""

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE referral_codes")
        conn.commit()
    yield


ADDR_A = "0x" + "ab" * 20
ADDR_B = "0x" + "cd" * 20


def _auth_client(app, address: str):
    client = app.test_client()
    token = jwt_mod.encode(address)
    client.set_cookie(SESSION_COOKIE, token, domain="localhost")
    return client


def _insert(code: str, owner: str) -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(
            "INSERT INTO referral_codes (code, owner_address) VALUES (%s, %s)",
            (code, owner),
        )
        conn.commit()


def _problem(resp):
    assert resp.headers["Content-Type"].startswith("application/problem+json")
    return resp.get_json()


# ─── GET /api/v1/ref/{code} ─────────────────────────────────────────────────


class TestResolveCode:
    def test_resolve_claimed_code(self, app) -> None:
        _insert("alex42", ADDR_A)
        resp = app.test_client().get("/api/v1/ref/alex42")
        assert resp.status_code == 200
        assert resp.get_json() == {"code": "alex42", "wallet": ADDR_A}
        assert resp.headers["Cache-Control"] == "public, max-age=60"

    def test_resolve_is_case_insensitive_on_input(self, app) -> None:
        _insert("alex42", ADDR_A)
        resp = app.test_client().get("/api/v1/ref/ALEX42")
        assert resp.status_code == 200
        assert resp.get_json()["code"] == "alex42"

    def test_unknown_code_returns_404(self, app) -> None:
        resp = app.test_client().get("/api/v1/ref/missing1")
        assert resp.status_code == 404
        assert _problem(resp)["code"] == "referral.not_found"
        assert resp.headers["Cache-Control"] == "no-store"

    def test_invalid_format_returns_404_not_422(self, app) -> None:
        # Per spec §5.2.1 — invalid format short-circuits to 404 (front doesn't
        # need to duplicate regex).
        resp = app.test_client().get("/api/v1/ref/ab")  # too short
        assert resp.status_code == 404
        assert _problem(resp)["code"] == "referral.not_found"

    def test_0x_address_returns_404(self, app) -> None:
        # 0x… doesn't match [a-z0-9_-]{4,32} because of length, so 404.
        resp = app.test_client().get("/api/v1/ref/" + ADDR_A)
        assert resp.status_code == 404


# ─── GET /api/v1/ref/me ─────────────────────────────────────────────────────


class TestGetMe:
    def test_unauthenticated_returns_401(self, app) -> None:
        resp = app.test_client().get("/api/v1/ref/me")
        assert resp.status_code == 401
        assert _problem(resp)["code"] == "auth.unauthenticated"

    def test_no_claim_returns_404(self, app) -> None:
        resp = _auth_client(app, ADDR_A).get("/api/v1/ref/me")
        assert resp.status_code == 404
        assert _problem(resp)["code"] == "referral.not_found"

    def test_returns_claim(self, app) -> None:
        _insert("alex42", ADDR_A)
        resp = _auth_client(app, ADDR_A).get("/api/v1/ref/me")
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["code"] == "alex42"
        assert body["wallet"] == ADDR_A
        assert isinstance(body["claimedAt"], int)


# ─── PUT /api/v1/ref/me ─────────────────────────────────────────────────────


class TestPutMe:
    def test_claim_happy_path(self, app) -> None:
        resp = _auth_client(app, ADDR_A).put("/api/v1/ref/me", json={"code": "alex42"})
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["code"] == "alex42"
        assert body["wallet"] == ADDR_A
        assert isinstance(body["claimedAt"], int)

    def test_uppercase_input_normalized_to_lowercase(self, app) -> None:
        resp = _auth_client(app, ADDR_A).put("/api/v1/ref/me", json={"code": "ALEX42"})
        assert resp.status_code == 200
        assert resp.get_json()["code"] == "alex42"

    def test_change_own_code_releases_old_and_inserts_new(self, app) -> None:
        c = _auth_client(app, ADDR_A)
        c.put("/api/v1/ref/me", json={"code": "alex42"})
        resp = c.put("/api/v1/ref/me", json={"code": "newname"})
        assert resp.status_code == 200
        assert resp.get_json()["code"] == "newname"
        # Old code should be free now — another wallet can grab it.
        c2 = _auth_client(app, ADDR_B)
        resp2 = c2.put("/api/v1/ref/me", json={"code": "alex42"})
        assert resp2.status_code == 200

    def test_claim_same_code_as_self_is_idempotent(self, app) -> None:
        c = _auth_client(app, ADDR_A)
        c.put("/api/v1/ref/me", json={"code": "alex42"})
        resp = c.put("/api/v1/ref/me", json={"code": "alex42"})
        assert resp.status_code == 200
        assert resp.get_json()["code"] == "alex42"

    def test_taken_by_other_wallet_returns_409(self, app) -> None:
        _insert("alex42", ADDR_A)
        resp = _auth_client(app, ADDR_B).put("/api/v1/ref/me", json={"code": "alex42"})
        assert resp.status_code == 409
        assert _problem(resp)["code"] == "referral.taken"

    @pytest.mark.parametrize(
        "code",
        ["abc", "x" * 33, "-abc", "abc-", "_abc", "abc_", "тест", "AB"],
    )
    def test_invalid_format_returns_422(self, app, code: str) -> None:
        resp = _auth_client(app, ADDR_A).put("/api/v1/ref/me", json={"code": code})
        assert resp.status_code == 422
        assert _problem(resp)["code"] == "referral.invalid_format"

    @pytest.mark.parametrize("code", ["admin", "static", "tokens"])
    def test_reserved_returns_422(self, app, code: str) -> None:
        resp = _auth_client(app, ADDR_A).put("/api/v1/ref/me", json={"code": code})
        assert resp.status_code == 422
        assert _problem(resp)["code"] == "referral.reserved"

    def test_null_code_releases_and_returns_204(self, app) -> None:
        c = _auth_client(app, ADDR_A)
        c.put("/api/v1/ref/me", json={"code": "alex42"})
        resp = c.put("/api/v1/ref/me", json={"code": None})
        assert resp.status_code == 204
        # And /me now 404s.
        assert c.get("/api/v1/ref/me").status_code == 404

    def test_empty_body_releases_and_returns_204(self, app) -> None:
        c = _auth_client(app, ADDR_A)
        c.put("/api/v1/ref/me", json={"code": "alex42"})
        resp = c.put("/api/v1/ref/me", data=b"")
        assert resp.status_code == 204

    def test_non_string_code_returns_400(self, app) -> None:
        resp = _auth_client(app, ADDR_A).put("/api/v1/ref/me", json={"code": 42})
        assert resp.status_code == 400
        assert _problem(resp)["code"] == "validation.bad_request"

    def test_unauthenticated_returns_401(self, app) -> None:
        resp = app.test_client().put("/api/v1/ref/me", json={"code": "alex42"})
        assert resp.status_code == 401


# ─── DELETE /api/v1/ref/me ──────────────────────────────────────────────────


class TestDeleteMe:
    def test_idempotent_without_claim(self, app) -> None:
        resp = _auth_client(app, ADDR_A).delete("/api/v1/ref/me")
        assert resp.status_code == 204

    def test_releases_existing_claim(self, app) -> None:
        c = _auth_client(app, ADDR_A)
        c.put("/api/v1/ref/me", json={"code": "alex42"})
        resp = c.delete("/api/v1/ref/me")
        assert resp.status_code == 204
        assert c.get("/api/v1/ref/me").status_code == 404

    def test_unauthenticated_returns_401(self, app) -> None:
        resp = app.test_client().delete("/api/v1/ref/me")
        assert resp.status_code == 401
