"""Integration: ``POST /api/v1/auth/verify`` (SIWE → JWT cookie)."""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from siwe import SiweMessage

from app import create_app


def _make_app():
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


@pytest.fixture()
def app():
    return _make_app()


@pytest.fixture(autouse=True)
def _clean_nonces():
    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("TRUNCATE TABLE auth_nonces")
        conn.commit()
    yield


def _issue_nonce(app) -> str:
    return app.test_client().get("/api/v1/auth/nonce").get_json()["nonce"]


def _seed_stale_nonce(nonce: str, age_minutes: int = 10) -> None:
    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute(
            "INSERT INTO auth_nonces (nonce, created_at) VALUES (%s, now() - %s)",
            (nonce, timedelta(minutes=age_minutes)),
        )
        conn.commit()


def _build_siwe(
    *,
    address: str,
    nonce: str,
    domain: str = "pitchterminal.app",
    uri: str = "https://pitchterminal.app",
    chain_id: int = 8453,
    issued_at: datetime | None = None,
) -> str:
    issued_at = issued_at or datetime.now(UTC).replace(microsecond=0)
    msg = SiweMessage(
        domain=domain,
        address=address,
        uri=uri,
        version="1",
        chain_id=chain_id,
        nonce=nonce,
        issued_at=issued_at.isoformat().replace("+00:00", "Z"),
        expiration_time=(issued_at + timedelta(minutes=5)).isoformat().replace("+00:00", "Z"),
        statement="Sign in to PitchTerminal.",
    )
    return msg.prepare_message()


def _sign(message: str, pk: str) -> str:
    signed = Account.sign_message(encode_defunct(text=message), private_key=pk)
    hex_sig = signed.signature.hex()
    return hex_sig if hex_sig.startswith("0x") else "0x" + hex_sig


def test_happy_path_sets_cookie(app) -> None:
    acct = Account.create()
    nonce = _issue_nonce(app)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, acct.key.hex())

    resp = app.test_client().post(
        "/api/v1/auth/verify",
        json={"message": msg, "signature": sig},
    )
    assert resp.status_code == 200, resp.get_data(as_text=True)
    body = resp.get_json()
    assert body["address"] == acct.address.lower()

    # Cookie attributes
    cookie_header = resp.headers.get("Set-Cookie", "")
    assert "pt_session=" in cookie_header
    assert "HttpOnly" in cookie_header
    assert "SameSite=Lax" in cookie_header
    assert "Path=/" in cookie_header
    assert "Max-Age=259200" in cookie_header  # 72*3600


def test_nonce_consumed_on_success(app) -> None:
    acct = Account.create()
    nonce = _issue_nonce(app)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, acct.key.hex())

    app.test_client().post("/api/v1/auth/verify", json={"message": msg, "signature": sig})

    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT 1 FROM auth_nonces WHERE nonce = %s", (nonce,))
        assert cur.fetchone() is None


def _problem_body(resp):
    assert resp.headers["Content-Type"].startswith("application/problem+json")
    return resp.get_json()


def test_invalid_signature_returns_401(app) -> None:
    acct = Account.create()
    other = Account.create()
    nonce = _issue_nonce(app)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, other.key.hex())

    resp = app.test_client().post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert resp.status_code == 401
    assert _problem_body(resp)["code"] == "auth.siwe.invalid_signature"


def test_unknown_nonce_returns_invalid_nonce(app) -> None:
    acct = Account.create()
    msg = _build_siwe(address=acct.address, nonce="nope" + "x" * 12)
    sig = _sign(msg, acct.key.hex())

    resp = app.test_client().post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert resp.status_code == 401
    assert _problem_body(resp)["code"] == "auth.siwe.invalid_nonce"


def test_stale_nonce_returns_invalid_nonce(app) -> None:
    acct = Account.create()
    nonce = "stalenonce123456"
    _seed_stale_nonce(nonce, age_minutes=10)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, acct.key.hex())

    resp = app.test_client().post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert resp.status_code == 401
    assert _problem_body(resp)["code"] == "auth.siwe.invalid_nonce"


def test_wrong_domain_returns_invalid_domain(app) -> None:
    acct = Account.create()
    nonce = _issue_nonce(app)
    msg = _build_siwe(address=acct.address, nonce=nonce, domain="evil.example")
    sig = _sign(msg, acct.key.hex())

    resp = app.test_client().post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert resp.status_code == 401
    assert _problem_body(resp)["code"] == "auth.siwe.invalid_domain"


def test_missing_body_fields_returns_400(app) -> None:
    resp = app.test_client().post("/api/v1/auth/verify", json={})
    assert resp.status_code == 400
    assert _problem_body(resp)["code"] == "validation.bad_request"


def test_nonce_single_use(app) -> None:
    """Replaying the same SIWE message after success returns invalid_nonce."""

    acct = Account.create()
    nonce = _issue_nonce(app)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, acct.key.hex())

    client = app.test_client()
    first = client.post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert first.status_code == 200

    second = client.post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert second.status_code == 401
    assert _problem_body(second)["code"] == "auth.siwe.invalid_nonce"
