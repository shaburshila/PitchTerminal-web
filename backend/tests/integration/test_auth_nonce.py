"""Integration: ``POST /api/v1/auth/nonce`` (address-bound nonce, security #5)."""

from __future__ import annotations

import psycopg
import pytest

from app import create_app


@pytest.fixture()
def app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture(autouse=True)
def _clean_nonces():
    import os

    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("TRUNCATE TABLE auth_nonces")
        conn.commit()
    yield


_VALID_ADDR = "0x71ECD1a09380cA46CcA741Bc48d04C556674756F"
_VALID_ADDR_LOWER = _VALID_ADDR.lower()


def _post_nonce(app, body=None):
    return app.test_client().post("/api/v1/auth/nonce", json=body)


def test_nonce_returns_200_with_shape(app) -> None:
    resp = _post_nonce(app, {"address": _VALID_ADDR})
    assert resp.status_code == 200
    body = resp.get_json()
    assert {"nonce", "issuedAt", "expiresAt"} <= body.keys()
    assert isinstance(body["nonce"], str)
    assert len(body["nonce"]) >= 16
    assert body["nonce"].isalnum()
    assert body["expiresAt"] - body["issuedAt"] == 5 * 60


def test_nonce_persisted_with_lowercased_address(app) -> None:
    import os

    resp = _post_nonce(app, {"address": _VALID_ADDR})
    nonce = resp.get_json()["nonce"]
    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT nonce, address FROM auth_nonces WHERE nonce = %s", (nonce,))
        row = cur.fetchone()
    assert row is not None
    assert row[0] == nonce
    # CHAR(42) — Postgres pads to 42; strip in case the driver returns padded.
    assert row[1].strip() == _VALID_ADDR_LOWER


def test_nonce_is_unique_per_call(app) -> None:
    client = app.test_client()
    seen = {
        client.post("/api/v1/auth/nonce", json={"address": _VALID_ADDR}).get_json()["nonce"]
        for _ in range(5)
    }
    assert len(seen) == 5


def test_missing_address_returns_400(app) -> None:
    resp = _post_nonce(app, {})
    assert resp.status_code == 400
    assert resp.get_json()["code"] == "validation.bad_request"


def test_missing_body_returns_400(app) -> None:
    # No JSON body at all.
    resp = app.test_client().post("/api/v1/auth/nonce")
    assert resp.status_code == 400
    assert resp.get_json()["code"] == "validation.bad_request"


def test_invalid_address_format_returns_400(app) -> None:
    for bad in ["not-hex", "0xabc", "0x" + "z" * 40, "71ECD1" + "a" * 36, 42]:
        resp = _post_nonce(app, {"address": bad})
        assert resp.status_code == 400, f"expected 400 for address={bad!r}"
        assert resp.get_json()["code"] == "validation.bad_request"


def test_rate_limit_enforced_at_30_per_min() -> None:
    # Spec §11: 30/min/IP for /auth/nonce.
    app = create_app(test_overrides={"RATELIMIT_ENABLED": True})
    client = app.test_client()
    last_status = None
    for _ in range(35):
        last_status = client.post("/api/v1/auth/nonce", json={"address": _VALID_ADDR}).status_code
    assert last_status == 429
