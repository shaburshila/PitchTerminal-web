"""Integration: ``GET /api/v1/auth/nonce``."""

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


def test_nonce_returns_200_with_shape(app) -> None:
    resp = app.test_client().get("/api/v1/auth/nonce")
    assert resp.status_code == 200
    body = resp.get_json()
    assert {"nonce", "issuedAt", "expiresAt"} <= body.keys()
    assert isinstance(body["nonce"], str)
    assert len(body["nonce"]) >= 16
    assert body["nonce"].isalnum()
    assert body["expiresAt"] - body["issuedAt"] == 5 * 60


def test_nonce_persisted_in_db(app) -> None:
    import os

    resp = app.test_client().get("/api/v1/auth/nonce")
    nonce = resp.get_json()["nonce"]
    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT nonce FROM auth_nonces WHERE nonce = %s", (nonce,))
        row = cur.fetchone()
    assert row is not None
    assert row[0] == nonce


def test_nonce_is_unique_per_call(app) -> None:
    client = app.test_client()
    seen = {client.get("/api/v1/auth/nonce").get_json()["nonce"] for _ in range(5)}
    assert len(seen) == 5


def test_rate_limit_enforced_at_30_per_min() -> None:
    # Spec §11: 30/min/IP for /auth/nonce.
    app = create_app(test_overrides={"RATELIMIT_ENABLED": True})
    client = app.test_client()
    # Burst past the limit; first 30 succeed, then 429.
    last_status = None
    for _ in range(35):
        last_status = client.get("/api/v1/auth/nonce").status_code
    assert last_status == 429
