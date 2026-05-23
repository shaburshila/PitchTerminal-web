"""RFC 7807 ``application/problem+json`` error responses.

Per docs/api-spec.md §1.4: every API error is serialized as

.. code-block:: json

    {
      "type": "https://pitchterminal.app/problems/<slug>",
      "title": "...",
      "status": 404,
      "code": "tokens.unknown",
      "detail": "..."
    }

with ``Content-Type: application/problem+json``.

The :func:`problem` helper builds the Flask ``Response``; :func:`abort_with_problem`
raises a ``ProblemHTTPException`` that the registered handler intercepts (so
endpoint code can early-exit without manually composing responses).

The health endpoint is an intentional exception — it returns plain
``application/json`` even on 503 (see api-spec §9.1) and therefore does NOT use
this helper.
"""

from __future__ import annotations

import json
from typing import Any

from flask import Flask, Response
from werkzeug.exceptions import HTTPException

_PROBLEM_BASE = "https://pitchterminal.app/problems/"

_PROBLEM_CONTENT_TYPE = "application/problem+json"


class ProblemHTTPException(HTTPException):
    """HTTP exception carrying a ready-made problem+json response."""

    def __init__(self, response: Response, status: int) -> None:
        super().__init__(description=None, response=response)
        self.code = status


def _problem_slug(code: str) -> str:
    """Map a ``code`` like ``tokens.unknown`` to a problem-type URL slug."""

    return code.replace(".", "-")


def problem(
    *,
    code: str,
    title: str,
    status: int,
    detail: str | None = None,
    type_: str | None = None,
    extra: dict[str, Any] | None = None,
) -> Response:
    """Build an RFC 7807 ``application/problem+json`` Flask ``Response``.

    Args:
        code: Stable machine-readable identifier (see api-spec.md §1.4 catalog).
        title: Short human-readable summary.
        status: HTTP status code.
        detail: Optional longer explanation.
        type_: Optional override for the ``type`` URL. Defaults to
            ``https://pitchterminal.app/problems/<code-with-dashes>``.
        extra: Additional top-level fields (e.g. ``retry_after`` for 429).
    """

    body: dict[str, Any] = {
        "type": type_ or (_PROBLEM_BASE + _problem_slug(code)),
        "title": title,
        "status": status,
        "code": code,
    }
    if detail is not None:
        body["detail"] = detail
    if extra:
        body.update(extra)

    return Response(
        response=json.dumps(body, separators=(",", ":")),
        status=status,
        mimetype=_PROBLEM_CONTENT_TYPE,
    )


def abort_with_problem(
    *,
    code: str,
    title: str,
    status: int,
    detail: str | None = None,
) -> None:
    """Raise a :class:`ProblemHTTPException` carrying a problem+json response.

    Endpoint code calls this to short-circuit with a structured error;
    the generic handler registered in :func:`register_error_handlers`
    just returns the attached response unchanged.
    """

    resp = problem(code=code, title=title, status=status, detail=detail)
    raise ProblemHTTPException(resp, status)


def register_error_handlers(app: Flask) -> None:
    """Register handlers so all errors come out as problem+json (except health)."""

    @app.errorhandler(ProblemHTTPException)
    def _handle_problem(exc: ProblemHTTPException) -> Response:
        # The response is already fully formed.
        assert exc.response is not None
        return exc.response  # type: ignore[return-value]

    @app.errorhandler(400)
    def _handle_400(exc: HTTPException) -> Response:
        return problem(
            code="validation.bad_request",
            title="Bad Request",
            status=400,
            detail=exc.description if isinstance(exc.description, str) else None,
        )

    @app.errorhandler(404)
    def _handle_404(exc: HTTPException) -> Response:
        return problem(
            code="route.not_found",
            title="Not Found",
            status=404,
            detail=exc.description if isinstance(exc.description, str) else None,
        )

    @app.errorhandler(405)
    def _handle_405(exc: HTTPException) -> Response:
        return problem(
            code="route.method_not_allowed",
            title="Method Not Allowed",
            status=405,
            detail=exc.description if isinstance(exc.description, str) else None,
        )

    @app.errorhandler(429)
    def _handle_429(exc: HTTPException) -> Response:
        # flask-limiter sets exc.description = "N per minute" by default.
        retry_after = getattr(exc, "retry_after", None)
        extra: dict[str, Any] = {}
        resp = problem(
            code="rate_limit.exceeded",
            title="Too Many Requests",
            status=429,
            detail=exc.description if isinstance(exc.description, str) else None,
            extra=extra,
        )
        # Preserve Retry-After if flask-limiter attached it to the response.
        original = getattr(exc, "response", None)
        if original is not None and "Retry-After" in original.headers:
            resp.headers["Retry-After"] = original.headers["Retry-After"]
        elif retry_after is not None:
            resp.headers["Retry-After"] = str(int(retry_after))
        return resp

    @app.errorhandler(500)
    def _handle_500(_exc: HTTPException) -> Response:
        return problem(
            code="server.internal",
            title="Internal Server Error",
            status=500,
        )

    @app.errorhandler(HTTPException)
    def _handle_http(exc: HTTPException) -> Response:
        # Any HTTPException without a specific handler above.
        status = exc.code or 500
        return problem(
            code=f"http.{status}",
            title=exc.name or "HTTP Error",
            status=status,
            detail=exc.description if isinstance(exc.description, str) else None,
        )

    @app.errorhandler(Exception)
    def _handle_generic(exc: Exception) -> Response:
        # Catch-all for non-HTTP exceptions — never leak the traceback.
        app.logger.exception("unhandled exception", exc_info=exc)
        return problem(
            code="server.internal",
            title="Internal Server Error",
            status=500,
        )


__all__ = [
    "ProblemHTTPException",
    "abort_with_problem",
    "problem",
    "register_error_handlers",
]
