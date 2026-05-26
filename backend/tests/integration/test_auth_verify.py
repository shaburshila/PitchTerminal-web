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


def _issue_nonce(app, address: str) -> str:
    """Issue a nonce bound to ``address`` via the public endpoint.

    Security #5: the server now stores the address alongside the nonce so
    ``/auth/verify`` will only accept signatures from that address.
    """

    resp = app.test_client().post("/api/v1/auth/nonce", json={"address": address})
    return resp.get_json()["nonce"]


def _seed_stale_nonce(nonce: str, address: str, age_minutes: int = 10) -> None:
    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute(
            "INSERT INTO auth_nonces (nonce, address, created_at) "
            "VALUES (%s, %s, now() - %s)",
            (nonce, address.lower(), timedelta(minutes=age_minutes)),
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
    nonce = _issue_nonce(app, acct.address)
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
    nonce = _issue_nonce(app, acct.address)
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
    nonce = _issue_nonce(app, acct.address)
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
    _seed_stale_nonce(nonce, acct.address, age_minutes=10)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, acct.key.hex())

    resp = app.test_client().post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert resp.status_code == 401
    assert _problem_body(resp)["code"] == "auth.siwe.invalid_nonce"


def test_wrong_domain_returns_invalid_domain(app) -> None:
    acct = Account.create()
    nonce = _issue_nonce(app, acct.address)
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
    nonce = _issue_nonce(app, acct.address)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, acct.key.hex())

    client = app.test_client()
    first = client.post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert first.status_code == 200

    second = client.post("/api/v1/auth/verify", json={"message": msg, "signature": sig})
    assert second.status_code == 401
    assert _problem_body(second)["code"] == "auth.siwe.invalid_nonce"


# ─── Security #5: SIWE nonce pre-harvesting prevention ─────────────────────


def test_nonce_bound_to_address_at_issue_time(app) -> None:
    """Nonce issued for address A is not redeemable by address B.

    Attack scenario: attacker pre-harvests a nonce by POSTing to
    ``/auth/nonce`` with their own (or a random) address. They build a
    phishing page hosted off our domain that re-uses our domain/uri/chain/
    statement constants and embeds the captured nonce. A victim signs the
    message on the phishing page (the wallet UI shows our domain in the
    statement so they trust it). The attacker captures the signature and
    POSTs it to ``/auth/verify`` — expecting a JWT for the victim.

    With the address-bound nonce, ``_consume_nonce_atomic`` rejects the
    victim's signature because the nonce was issued for the attacker's
    address; the verify returns 401 invalid_nonce.
    """

    attacker = Account.create()
    victim = Account.create()
    # Attacker pre-harvests a nonce bound to their own address.
    nonce = _issue_nonce(app, attacker.address)
    # Victim signs a SIWE message containing that nonce (assume the wallet
    # was tricked into producing a valid signature).
    msg = _build_siwe(address=victim.address, nonce=nonce)
    sig = _sign(msg, victim.key.hex())

    resp = app.test_client().post(
        "/api/v1/auth/verify", json={"message": msg, "signature": sig}
    )
    assert resp.status_code == 401
    assert _problem_body(resp)["code"] == "auth.siwe.invalid_nonce"

    # The bogus attempt also burns the nonce so the attacker can't re-try
    # with a different victim — verify the row is gone.
    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT 1 FROM auth_nonces WHERE nonce = %s", (nonce,))
        assert cur.fetchone() is None


def test_nonce_redeemable_by_originally_declared_address(app) -> None:
    """Sanity counterpart: same address that requested the nonce can verify."""

    acct = Account.create()
    nonce = _issue_nonce(app, acct.address)
    msg = _build_siwe(address=acct.address, nonce=nonce)
    sig = _sign(msg, acct.key.hex())

    resp = app.test_client().post(
        "/api/v1/auth/verify", json={"message": msg, "signature": sig}
    )
    assert resp.status_code == 200
    assert resp.get_json()["address"] == acct.address.lower()
