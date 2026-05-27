"""Integration: ``POST /api/v1/auth/nonce`` (address-less nonce).

Background: AppKit / WalletConnect SIWE drivers invoke ``getNonce`` *before*
wallet pairing completes, so we cannot bind to an address at issue time. The
endpoint now accepts an empty body; an optional ``address`` is accepted for
backward compatibility but ignored. Signer binding is enforced at verify-
time (see :mod:`test_auth_verify`).
"""

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


def _post_nonce(app, body=None):
    return app.test_client().post("/api/v1/auth/nonce", json=body)


def test_nonce_returns_200_with_shape_empty_body(app) -> None:
    """Address-less body (AppKit/WC path) returns a valid nonce."""

    resp = _post_nonce(app, {})
    assert resp.status_code == 200
    body = resp.get_json()
    assert {"nonce", "issuedAt", "expiresAt"} <= body.keys()
    assert isinstance(body["nonce"], str)
    assert len(body["nonce"]) >= 16
    assert body["nonce"].isalnum()
    assert body["expiresAt"] - body["issuedAt"] == 5 * 60


def test_nonce_returns_200_with_no_body(app) -> None:
    """No JSON body at all is fine — AppKit's `getNonce` posts an empty body."""

    resp = app.test_client().post("/api/v1/auth/nonce")
    assert resp.status_code == 200
    body = resp.get_json()
    assert isinstance(body["nonce"], str)
    assert len(body["nonce"]) >= 16


def test_nonce_returns_200_with_legacy_address_body(app) -> None:
    """Backward compat: clients still sending `{address}` get a 200 — address ignored."""

    resp = _post_nonce(app, {"address": _VALID_ADDR})
    assert resp.status_code == 200
    body = resp.get_json()
    assert isinstance(body["nonce"], str)


def test_nonce_persisted_with_null_address(app) -> None:
    """New rows have ``address IS NULL`` — issue-time binding is gone."""

    import os

    resp = _post_nonce(app, {})
    nonce = resp.get_json()["nonce"]
    with (
        psycopg.connect(os.environ["DATABASE_URL"]) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT nonce, address FROM auth_nonces WHERE nonce = %s", (nonce,))
        row = cur.fetchone()
    assert row is not None
    assert row[0] == nonce
    assert row[1] is None


def test_nonce_is_unique_per_call(app) -> None:
    client = app.test_client()
    seen = {client.post("/api/v1/auth/nonce").get_json()["nonce"] for _ in range(5)}
    assert len(seen) == 5


def test_malformed_legacy_address_returns_400(app) -> None:
    """If a client opts in to sending `address`, it must be well-formed —
    silently accepting garbage would confuse upstream callers debugging a
    typo. Note: the address is still ignored even when valid."""

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
        last_status = client.post("/api/v1/auth/nonce").status_code
    assert last_status == 429
