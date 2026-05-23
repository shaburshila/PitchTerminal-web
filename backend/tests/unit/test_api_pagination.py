"""Unit tests for ``app.pagination`` — opaque cursor round-trip + clamp_limit."""

from __future__ import annotations

import pytest
from flask import Flask
from werkzeug.exceptions import HTTPException

from app.errors import register_error_handlers
from app.pagination import clamp_limit, decode_cursor, encode_cursor


@pytest.fixture()
def app_ctx():
    """A minimal Flask app context — needed because ``abort_with_problem``
    raises ``ProblemHTTPException`` (an HTTPException subclass) and the
    test harness needs an app context to format the response."""

    app = Flask(__name__)
    register_error_handlers(app)
    with app.app_context():
        yield app


class TestCursorRoundTrip:
    def test_encode_decode_identity(self) -> None:
        payload = {"b": 12345, "l": 7}
        encoded = encode_cursor(payload)
        assert "=" not in encoded  # no padding
        assert encoded == encode_cursor(payload)  # deterministic
        decoded = decode_cursor(encoded)
        assert decoded == payload

    def test_encode_url_safe(self) -> None:
        payload = {"b": 99999999, "l": 0}
        encoded = encode_cursor(payload)
        # Only URL-safe characters.
        assert all(c.isalnum() or c in "-_" for c in encoded)

    def test_decode_invalid_b64(self, app_ctx: Flask) -> None:
        with pytest.raises(HTTPException) as exc:
            decode_cursor("!!!not-base64!!!")
        assert exc.value.code == 400

    def test_decode_not_object(self, app_ctx: Flask) -> None:
        # Encode a non-dict payload manually.
        import base64
        import json

        raw = base64.urlsafe_b64encode(json.dumps([1, 2, 3]).encode()).rstrip(b"=").decode()
        with pytest.raises(HTTPException) as exc:
            decode_cursor(raw)
        assert exc.value.code == 400


class TestClampLimit:
    def test_default(self) -> None:
        assert clamp_limit(None) == 100

    def test_empty(self) -> None:
        assert clamp_limit("") == 100

    def test_valid(self) -> None:
        assert clamp_limit("50") == 50

    def test_int_input(self) -> None:
        assert clamp_limit(25) == 25

    def test_too_low(self, app_ctx: Flask) -> None:
        with pytest.raises(HTTPException) as exc:
            clamp_limit("0")
        assert exc.value.code == 400

    def test_too_high(self, app_ctx: Flask) -> None:
        with pytest.raises(HTTPException) as exc:
            clamp_limit("501")
        assert exc.value.code == 400

    def test_non_int(self, app_ctx: Flask) -> None:
        with pytest.raises(HTTPException) as exc:
            clamp_limit("abc")
        assert exc.value.code == 400
