"""Unit tests for the SSE formatter helpers in :mod:`app.routes.stream`.

These don't need a Flask app or DB — they exercise pure-function frame
formatting + payload parsing.
"""

from __future__ import annotations

from app.routes import stream as stream_mod


class TestFmtEvent:
    def test_emits_event_id_data_blank(self) -> None:
        frame = stream_mod._fmt_event("prices", 42, {"foo": "bar"})
        assert frame.startswith("event: prices\n")
        assert "id: 42\n" in frame
        assert 'data: {"foo":"bar"}\n' in frame  # compact json
        assert frame.endswith("\n\n")  # trailing blank line

    def test_list_payload_works(self) -> None:
        frame = stream_mod._fmt_event("events", 1, [{"a": 1}])
        assert 'data: [{"a":1}]\n' in frame


class TestKeepalive:
    def test_is_comment_line(self) -> None:
        ka = stream_mod._keepalive()
        assert ka == ": keepalive\n\n"


class TestParseAddresses:
    def test_lowercase_normalization(self) -> None:
        out = stream_mod._parse_addresses('["0xABC", "0xDEF"]')
        assert out == ["0xabc", "0xdef"]

    def test_empty_list_is_passthrough(self) -> None:
        assert stream_mod._parse_addresses("[]") == []

    def test_bad_json_returns_empty(self) -> None:
        assert stream_mod._parse_addresses("not json") == []

    def test_non_list_returns_empty(self) -> None:
        assert stream_mod._parse_addresses('{"x": 1}') == []


class TestParseEventIds:
    def test_int_coercion(self) -> None:
        out = stream_mod._parse_event_ids("[1, 2, 3]")
        assert out == [1, 2, 3]

    def test_string_ids_also_coerced(self) -> None:
        out = stream_mod._parse_event_ids('["10", "20"]')
        assert out == [10, 20]

    def test_bad_json(self) -> None:
        assert stream_mod._parse_event_ids("xxx") == []
