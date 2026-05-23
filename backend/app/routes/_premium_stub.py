"""Temporary premium-guard stub for B0.13.

The real ``@require_premium`` decorator is B0.12 — it will read the cached
``hasAccess`` from the access-contract layer (B0.11). Until that lands, premium
endpoints need *some* guard that:

* still enforces a valid ``pt_session`` cookie (so the test surface is
  realistic — the route gets a wallet address from ``g.address``),
* lets tests / local-dev opt in to "I have access" without spinning up the
  contract, via ``PREMIUM_STUB_BYPASS=1``,
* returns the same 402 ``access.required`` problem+json shape the real
  decorator will use (so frontend/tests written against the stub don't need
  to change once B0.12 ships).

TODO(B0.12): delete this file; replace ``require_premium_stub`` with the real
``require_premium`` from ``app.deps`` (or wherever B0.12 puts it). The route
modules import it as ``require_premium_stub`` so a single rename will do.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from functools import wraps
from typing import Any, TypeVar, cast

from app.deps import require_auth
from app.errors import abort_with_problem

F = TypeVar("F", bound=Callable[..., Any])


def _stub_bypass_enabled() -> bool:
    """Read ``PREMIUM_STUB_BYPASS`` at call time (not import) so tests can flip it."""

    return os.environ.get("PREMIUM_STUB_BYPASS", "").strip().lower() in {"1", "true", "yes", "on"}


def require_premium_stub(fn: F) -> F:
    """Auth + temporary premium gate.

    Wraps ``require_auth`` (so 401 still fires on no cookie / bad JWT) and then
    consults ``PREMIUM_STUB_BYPASS`` for the access check:

    * ``PREMIUM_STUB_BYPASS=1`` → premium allowed, view runs with ``g.address``.
    * anything else → 402 ``access.required`` problem+json.
    """

    @wraps(fn)
    def inner(*args: Any, **kwargs: Any) -> Any:
        if not _stub_bypass_enabled():
            abort_with_problem(
                code="access.payment_required",
                title="Premium access required",
                status=402,
                detail="This endpoint requires an active PitchTerminal Access pass",
            )
        return fn(*args, **kwargs)

    return cast(F, require_auth(inner))


__all__ = ["require_premium_stub"]
