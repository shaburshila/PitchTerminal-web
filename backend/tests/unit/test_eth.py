"""Unit tests for ``shared.eth`` address helpers."""

from __future__ import annotations

import pytest

from shared.eth import chk, is_address, lc

VALID_LC = "0xca11bde05977b3631167028862be2a173976ca11"
VALID_MIXED = "0xcA11bde05977b3631167028862bE2a173976CA11"


class TestLc:
    def test_lowercases_mixed_case(self) -> None:
        assert lc(VALID_MIXED) == VALID_LC

    def test_already_lowercase_unchanged(self) -> None:
        assert lc(VALID_LC) == VALID_LC

    def test_empty_string_raises(self) -> None:
        with pytest.raises(ValueError):
            lc("")

    def test_too_short_raises(self) -> None:
        with pytest.raises(ValueError):
            lc("0x1234")

    def test_too_long_raises(self) -> None:
        with pytest.raises(ValueError):
            lc(VALID_LC + "ab")

    def test_no_0x_prefix_raises(self) -> None:
        with pytest.raises(ValueError):
            lc(VALID_LC[2:])

    def test_non_hex_char_raises(self) -> None:
        with pytest.raises(ValueError):
            lc("0x" + "z" * 40)


class TestChk:
    def test_returns_checksum_form(self) -> None:
        result = chk(VALID_LC)
        # EIP-55 checksum is mixed-case; should NOT equal the lowercase form.
        assert result.lower() == VALID_LC
        assert result != VALID_LC  # actually mixed-case for this addr

    def test_chk_accepts_mixed_case(self) -> None:
        result = chk(VALID_MIXED)
        assert result.lower() == VALID_LC

    def test_chk_invalid_raises(self) -> None:
        # web3 raises a specific subclass (InvalidAddress / ValueError) — catch broadly.
        with pytest.raises((ValueError, TypeError)):
            chk("not-an-address")


class TestIsAddress:
    def test_valid_lowercase_true(self) -> None:
        assert is_address(VALID_LC) is True

    def test_mixed_case_false(self) -> None:
        # is_address checks the *normalized* form only.
        assert is_address(VALID_MIXED) is False

    def test_empty_false(self) -> None:
        assert is_address("") is False

    def test_short_false(self) -> None:
        assert is_address("0x1234") is False

    def test_no_prefix_false(self) -> None:
        assert is_address(VALID_LC[2:]) is False

    def test_non_string_false(self) -> None:
        assert is_address(12345) is False  # type: ignore[arg-type]
