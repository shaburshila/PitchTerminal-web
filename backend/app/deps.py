"""Route-level dependencies (auth + premium decorators)."""

from __future__ import annotations

from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar, cast

from flask import g, request

from app.errors import abort_with_problem
from shared.access import is_premium
from shared.jwt import JwtError, decode

SESSION_COOKIE = "pt_session"

F = TypeVar("F", bound=Callable[..., Any])


def require_auth(fn: F) -> F:
    """Decorator that demands a valid ``pt_session`` cookie.

    On success: sets ``g.address`` (lowercase) and invokes the wrapped view.
    On failure: 401 ``application/problem+json`` with code ``auth.unauthenticated``
    (or ``auth.jwt.expired`` for expired tokens — both still 401, but the
    machine-readable code lets the front re-trigger SIWE rather than redirect
    to "wallet not connected").
    """

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        token = request.cookies.get(SESSION_COOKIE)
        if not token:
            abort_with_problem(
                code="auth.unauthenticated",
                title="Unauthenticated",
                status=401,
                detail="Missing pt_session cookie",
            )
            return  # unreachable — abort_with_problem raises

        try:
            address = decode(token)
        except JwtError as exc:
            abort_with_problem(
                code=exc.code,
                title="Unauthenticated",
                status=401,
                detail=str(exc) or "Invalid session",
            )
            return  # unreachable

        g.address = address
        return fn(*args, **kwargs)

    return cast(F, wrapper)


def require_premium(fn: F) -> F:
    """Decorator that demands a valid session **and** active premium access.

    Composes :func:`require_auth` (so 401 still fires on no cookie / bad JWT)
    with a :func:`shared.access.is_premium` check. On a negative ``hasAccess``
    result, returns 402 ``access.payment_required`` via problem+json (per
    api-spec §1.4 catalog).

    The wrapped view sees the same ``g.address`` set by :func:`require_auth`.

    Per docs/plans/backend.md B0.12 — replaces the temporary
    ``require_premium_stub`` once B0.11's cached ``hasAccess`` lands.
    """

    @wraps(fn)
    def inner(*args: Any, **kwargs: Any) -> Any:
        status = is_premium(g.address)
        if not status.has_access:
            abort_with_problem(
                code="access.payment_required",
                title="Premium access required",
                status=402,
                detail="This endpoint requires an active PitchTerminal Access pass",
            )
            return  # unreachable — abort_with_problem raises
        return fn(*args, **kwargs)

    return cast(F, require_auth(inner))


__all__ = ["SESSION_COOKIE", "require_auth", "require_premium"]
