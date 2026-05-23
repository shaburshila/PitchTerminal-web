"""Unit tests for :func:`shared.referral.validate_code`."""

from __future__ import annotations

import pytest

from shared.referral import InvalidFormat, Reserved, validate_code


class TestValidFormats:
    @pytest.mark.parametrize(
        "code",
        ["alex", "alex42", "a-b-c", "user_42", "x" * 32, "0xab", "test"],
    )
    def test_accepts(self, code: str) -> None:
        validate_code(code)  # does not raise


class TestInvalidFormats:
    @pytest.mark.parametrize(
        "code",
        [
            "abc",  # too short
            "x" * 33,  # too long
            "ALEX",  # uppercase
            "-abc",  # leading dash
            "abc-",  # trailing dash
            "_abc",  # leading underscore
            "abc_",  # trailing underscore
            "ab cd",  # space
            "ab.cd",  # dot
            "тест",  # cyrillic
            "",  # empty
        ],
    )
    def test_rejects(self, code: str) -> None:
        with pytest.raises(InvalidFormat):
            validate_code(code)


class TestReserved:
    @pytest.mark.parametrize("code", ["admin", "static", "auth", "stream", "tokens"])
    def test_rejects_reserved(self, code: str) -> None:
        with pytest.raises(Reserved):
            validate_code(code)
