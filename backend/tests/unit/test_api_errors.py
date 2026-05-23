"""Unit tests for ``app.errors`` — problem+json builder + handlers."""

from __future__ import annotations

import json

import pytest
from flask import Flask
from werkzeug.exceptions import HTTPException

from app.errors import abort_with_problem, problem, register_error_handlers


class TestProblemBuilder:
    def test_basic(self) -> None:
        resp = problem(code="tokens.unknown", title="Unknown token", status=404)
        assert resp.status_code == 404
        assert resp.mimetype == "application/problem+json"
        body = json.loads(resp.get_data())
        assert body == {
            "type": "https://pitchterminal.app/problems/tokens-unknown",
            "title": "Unknown token",
            "status": 404,
            "code": "tokens.unknown",
        }

    def test_with_detail(self) -> None:
        resp = problem(
            code="validation.bad_request",
            title="Bad",
            status=400,
            detail="missing field 'x'",
        )
        body = json.loads(resp.get_data())
        assert body["detail"] == "missing field 'x'"

    def test_with_custom_type(self) -> None:
        resp = problem(
            code="server.internal",
            title="Oops",
            status=500,
            type_="https://example.com/oops",
        )
        body = json.loads(resp.get_data())
        assert body["type"] == "https://example.com/oops"


class TestAbortWithProblem:
    def test_raises(self) -> None:
        app = Flask(__name__)
        register_error_handlers(app)
        with app.app_context(), pytest.raises(HTTPException) as exc:
            abort_with_problem(
                code="tokens.unknown",
                title="Unknown token",
                status=404,
            )
        assert exc.value.code == 404


class TestErrorHandlers:
    def _make_app(self) -> Flask:
        app = Flask(__name__)
        register_error_handlers(app)

        @app.get("/boom")
        def boom() -> str:
            abort_with_problem(
                code="tokens.unknown",
                title="Unknown",
                status=404,
            )
            return "unreachable"

        @app.get("/explode")
        def explode() -> str:
            raise RuntimeError("kaboom")

        return app

    def test_problem_route_serializes(self) -> None:
        app = self._make_app()
        resp = app.test_client().get("/boom")
        assert resp.status_code == 404
        assert resp.mimetype == "application/problem+json"
        body = resp.get_json()
        assert body["code"] == "tokens.unknown"

    def test_unknown_route_404(self) -> None:
        app = self._make_app()
        resp = app.test_client().get("/no-such-thing")
        assert resp.status_code == 404
        assert resp.mimetype == "application/problem+json"
        body = resp.get_json()
        assert body["code"] == "route.not_found"

    def test_unhandled_exception_500(self) -> None:
        app = self._make_app()
        # Need testing flag off so 500 handler runs (Flask propagates in debug).
        app.config["TESTING"] = False
        app.config["PROPAGATE_EXCEPTIONS"] = False
        resp = app.test_client().get("/explode")
        assert resp.status_code == 500
        assert resp.mimetype == "application/problem+json"
        body = resp.get_json()
        assert body["code"] == "server.internal"
