"""Tests for the structlog redaction processor in ``shared.log``."""

from __future__ import annotations

import hashlib
import io
import json
from contextlib import redirect_stdout

from shared.log import get_logger, redact_processor


def _capture_log(call) -> str:
    """Run ``call()`` and return captured stdout."""

    buf = io.StringIO()
    with redirect_stdout(buf):
        call()
    return buf.getvalue()


class TestRedactProcessorUnit:
    def test_sensitive_keys_redacted(self) -> None:
        out = redact_processor(
            None,  # type: ignore[arg-type]
            "info",
            {
                "signature": "0xabcdef0123456789",
                "private_key": "deadbeef",
                "cookie": "session=foo",
                "password": "hunter2",
                "user_token": "abc123",
                "addr": "0xabc",  # not sensitive
            },
        )
        assert out["signature"] == "<redacted>"
        assert out["private_key"] == "<redacted>"
        assert out["cookie"] == "<redacted>"
        assert out["password"] == "<redacted>"
        assert out["user_token"] == "<redacted>"
        assert out["addr"] == "0xabc"

    def test_jwt_value_becomes_marker_even_on_sensitive_key(self) -> None:
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIweGFiYyJ9.abc-def_XYZ"
        out = redact_processor(
            None,  # type: ignore[arg-type]
            "info",
            {"token": jwt},
        )
        expected = f"jwt:{hashlib.sha256(jwt.encode()).hexdigest()[:8]}"
        assert out["token"] == expected

    def test_jwt_in_non_sensitive_key_also_replaced(self) -> None:
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIweGFiYyJ9.abc-def_XYZ"
        out = redact_processor(
            None,  # type: ignore[arg-type]
            "info",
            {"context": jwt},
        )
        assert out["context"].startswith("jwt:")

    def test_long_hex_redacted(self) -> None:
        long_hex = "0x" + "a" * 130
        out = redact_processor(
            None,  # type: ignore[arg-type]
            "info",
            {"data": long_hex},
        )
        assert out["data"] == "<redacted>"

    def test_short_strings_untouched(self) -> None:
        out = redact_processor(
            None,  # type: ignore[arg-type]
            "info",
            {"msg": "hello", "addr": "0x1234"},
        )
        assert out["msg"] == "hello"
        assert out["addr"] == "0x1234"

    def test_nested_dict_redacted(self) -> None:
        out = redact_processor(
            None,  # type: ignore[arg-type]
            "info",
            {
                "outer": {
                    "signature": "deadbeefdeadbeef",
                    "ok": "value",
                }
            },
        )
        assert out["outer"]["signature"] == "<redacted>"
        assert out["outer"]["ok"] == "value"


class TestEndToEndLogOutput:
    def test_logged_json_does_not_contain_raw_secret(self) -> None:
        log = get_logger("test")
        raw_sig = "0xabcdef0123456789" * 10
        raw_priv = "0x" + "f" * 64
        jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIweGFiYyJ9.signed_part_here"

        output = _capture_log(
            lambda: log.info(
                "trade.signed",
                signature=raw_sig,
                private_key=raw_priv,
                token=jwt,
                cookie="pt_session=abcdef",
            )
        )

        # The raw sensitive values must NOT appear in the output.
        assert raw_sig not in output
        assert raw_priv not in output
        assert jwt not in output
        assert "abcdef" not in output or "<redacted>" in output

        # Redaction markers must be present.
        assert "<redacted>" in output
        # JWT marker has form "jwt:<8-hex>"
        expected_jwt_marker = f"jwt:{hashlib.sha256(jwt.encode()).hexdigest()[:8]}"
        assert expected_jwt_marker in output

        # Must still be parseable as JSON (one object per line).
        last_line = [line for line in output.splitlines() if line.strip()][-1]
        parsed = json.loads(last_line)
        assert parsed["event"] == "trade.signed"
        assert parsed["component"] == "test"
        assert parsed["signature"] == "<redacted>"
        assert parsed["private_key"] == "<redacted>"
        assert parsed["cookie"] == "<redacted>"
        assert parsed["token"] == expected_jwt_marker
