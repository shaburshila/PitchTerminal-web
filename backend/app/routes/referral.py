"""``/api/v1/ref`` family — opt-in referral handle resolve + claim.

Per docs/api-spec.md §5.2 + docs/plans/backend.md B0.11b:

* ``GET    /api/v1/ref/{code}`` (FREE, 120/min/IP)   — resolve code → wallet.
* ``GET    /api/v1/ref/me``     (AUTH, 30/min/addr)  — current handle of caller.
* ``PUT    /api/v1/ref/me``     (AUTH, 5/hour/addr) — claim/change/release.
* ``DELETE /api/v1/ref/me``     (AUTH, 5/hour/addr) — idempotent release.

Format rules (regex + reserved) live in :mod:`shared.referral`. The DB CHECK
constraint mirrors the regex, but we validate up front so invalid input never
hits Postgres.
"""

from __future__ import annotations

from typing import Any

from flask import Blueprint, current_app, g, jsonify, request
from flask_limiter.util import get_remote_address
from psycopg import errors as pg_errors

from app.deps import require_auth
from app.errors import abort_with_problem
from app.limits import limiter
from shared.db import get_conn
from shared.referral import InvalidFormat, Reserved, validate_code

bp = Blueprint("referral", __name__)


def _addr_key() -> str:
    # spec §11: AUTH ref/me limits keyed by wallet address; fall back to IP
    # when called outside an authenticated request (e.g. before require_auth
    # rejects).
    return getattr(g, "address", None) or get_remote_address()


def _serialize_row(row: dict[str, Any]) -> dict[str, Any]:
    """Shape a ``referral_codes`` row for /me responses (spec §5.2.2/5.2.3)."""

    return {
        "code": row["code"],
        "wallet": row["owner_address"].strip(),
        "claimedAt": int(row["claimed_at_ts"]),
    }


# ─── GET /api/v1/ref/{code} ──────────────────────────────────────────────────


@bp.get("/api/v1/ref/<code>")
@limiter.limit("120 per minute")
def get_code(code: str) -> Any:
    """Resolve ``code`` → wallet (spec §5.2.1, FREE).

    Invalid format short-circuits to 404 (not 422) per spec — saves the front
    from duplicating regex.
    """

    code_norm = code.lower()
    try:
        validate_code(code_norm)
    except (InvalidFormat, Reserved):
        abort_with_problem(
            code="referral.not_found",
            title="Referral code not found",
            status=404,
        )

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT code, owner_address FROM referral_codes WHERE code = %s",
            (code_norm,),
        )
        row = cur.fetchone()

    if row is None:
        resp = current_app.response_class(
            response='{"type":"https://pitchterminal.app/problems/referral-not-found",'
            '"title":"Referral code not found","status":404,'
            '"code":"referral.not_found"}',
            status=404,
            mimetype="application/problem+json",
        )
        resp.headers["Cache-Control"] = "no-store"
        return resp

    resp = jsonify(
        {
            "code": row["code"],
            "wallet": row["owner_address"].strip(),
        }
    )
    resp.headers["Cache-Control"] = "public, max-age=60"
    return resp


# ─── GET /api/v1/ref/me ──────────────────────────────────────────────────────


@bp.get("/api/v1/ref/me")
@limiter.limit("30 per minute", key_func=_addr_key)
@require_auth
def get_me() -> Any:
    """Current handle of the caller (spec §5.2.2, AUTH)."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT code, owner_address, "
            "EXTRACT(EPOCH FROM claimed_at)::bigint AS claimed_at_ts "
            "FROM referral_codes WHERE owner_address = %s",
            (g.address,),
        )
        row = cur.fetchone()

    if row is None:
        abort_with_problem(
            code="referral.not_found",
            title="No referral code claimed",
            status=404,
        )

    assert row is not None
    return jsonify(_serialize_row(dict(row)))


# ─── PUT /api/v1/ref/me ──────────────────────────────────────────────────────


def _delete_for_owner(owner: str) -> None:
    """Idempotent release helper. Used by both PUT(code=null) and DELETE."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM referral_codes WHERE owner_address = %s", (owner,))


@bp.put("/api/v1/ref/me")
@limiter.limit("5 per hour", key_func=_addr_key)
@require_auth
def put_me() -> Any:
    """Atomic create/change/release of the caller's handle (spec §5.2.3, AUTH).

    Body forms:
    * ``{"code": "alex42"}`` — claim or change.
    * ``{"code": null}`` or empty body — release (204).

    Race semantics: ``DELETE owner=g.address; INSERT (code, g.address)`` runs in
    a single transaction; the unique PK on ``code`` makes the parallel-claim
    race resolve as one 200 + one 409 at the Postgres level.
    """

    if request.content_length in (0, None) and not request.data:
        _delete_for_owner(g.address)
        return current_app.response_class(status=204)

    payload = request.get_json(silent=True) or {}
    raw_code = payload.get("code", "__missing__")

    if raw_code is None:
        _delete_for_owner(g.address)
        return current_app.response_class(status=204)

    if not isinstance(raw_code, str):
        abort_with_problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail="Body must contain string field 'code' or null",
        )

    assert isinstance(raw_code, str)
    code_norm = raw_code.lower()

    try:
        validate_code(code_norm)
    except InvalidFormat as exc:
        abort_with_problem(
            code="referral.invalid_format",
            title="Invalid referral code format",
            status=422,
            detail=str(exc) or None,
        )
    except Reserved as exc:
        abort_with_problem(
            code="referral.reserved",
            title="Referral code is reserved",
            status=422,
            detail=str(exc) or None,
        )

    # Atomic DELETE+INSERT under a single transaction. psycopg's default
    # behaviour on `with conn:` is to begin a transaction and commit on exit
    # (or rollback on exception) — which is exactly what we need here.
    try:
        with get_conn() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM referral_codes WHERE owner_address = %s",
                (g.address,),
            )
            cur.execute(
                "INSERT INTO referral_codes (code, owner_address) "
                "VALUES (%s, %s) "
                "RETURNING code, owner_address, "
                "EXTRACT(EPOCH FROM claimed_at)::bigint AS claimed_at_ts",
                (code_norm, g.address),
            )
            row = cur.fetchone()
    except pg_errors.UniqueViolation:
        abort_with_problem(
            code="referral.taken",
            title="Referral code already taken",
            status=409,
        )

    assert row is not None
    return jsonify(_serialize_row(dict(row)))


# ─── DELETE /api/v1/ref/me ───────────────────────────────────────────────────


@bp.delete("/api/v1/ref/me")
@limiter.limit("5 per hour", key_func=_addr_key)
@require_auth
def delete_me() -> Any:
    """Idempotent release (spec §5.2.4, AUTH). Always 204."""

    _delete_for_owner(g.address)
    return current_app.response_class(status=204)


__all__ = ["bp"]
