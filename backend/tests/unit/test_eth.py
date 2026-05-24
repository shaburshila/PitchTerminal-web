"""Unit tests for ``shared.eth`` address helpers."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from shared.eth import (
    _encode_balance_of_calldata,
    chk,
    is_address,
    lc,
    wallet_balances,
)

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


# ─── wallet_balances ────────────────────────────────────────────────────────


_WALLET = "0x" + "ab" * 20
_PITCH = "0x" + "11" * 20
_BRA = "0x" + "22" * 20
_GER = "0x" + "33" * 20


def _wei_to_returndata(value: int) -> bytes:
    """ABI-encode a uint256 as the 32-byte returnData a real RPC would give."""

    return value.to_bytes(32, "big")


def _make_w3(eth_balance: int, multicall_returns: list[bytes]) -> Any:
    """Build a MagicMock Web3 that satisfies the call surface of ``wallet_balances``.

    The Multicall3 contract handle is returned by ``w3.eth.contract(...)``;
    its ``functions.aggregate3(...).call()`` yields a list of
    ``(success, returnData)`` tuples — we set success=True for every entry
    (per-call failure handling is tested separately via empty returnData).
    """

    w3 = MagicMock()
    w3.eth.get_balance.return_value = eth_balance
    w3.to_checksum_address.side_effect = lambda a: a  # passthrough; signature only
    # Build the aggregate3 fake.
    contract = MagicMock()
    aggregate3_fn = MagicMock()
    aggregate3_fn.return_value.call.return_value = [(len(r) > 0, r) for r in multicall_returns]
    contract.functions.aggregate3 = aggregate3_fn
    w3.eth.contract.return_value = contract
    return w3


class TestEncodeBalanceOfCalldata:
    def test_selector_plus_padded_address(self) -> None:
        cd = _encode_balance_of_calldata(_WALLET)
        # 4-byte selector + 12 zeros + 20-byte address = 36 bytes.
        assert len(cd) == 4 + 32
        assert cd[:4].hex() == "70a08231"
        assert cd[4:16] == b"\x00" * 12
        assert cd[16:].hex() == _WALLET[2:]

    def test_invalid_address_raises(self) -> None:
        with pytest.raises(ValueError):
            _encode_balance_of_calldata("0xdeadbeef")


class TestWalletBalances:
    def test_eth_only_when_no_tokens(self) -> None:
        w3 = _make_w3(eth_balance=12345, multicall_returns=[])
        bals = wallet_balances(w3, _WALLET, pitch_token="", country_addresses=[])
        assert bals.eth_wei == 12345
        assert bals.pitch_wei == 0
        assert bals.countries == []
        # No multicall when no targets — contract handle never built.
        w3.eth.contract.assert_not_called()

    def test_pitch_and_countries(self) -> None:
        # Multicall returns: PITCH=100, BRA=50, GER=200.
        returns = [
            _wei_to_returndata(100),
            _wei_to_returndata(50),
            _wei_to_returndata(200),
        ]
        w3 = _make_w3(eth_balance=7, multicall_returns=returns)
        bals = wallet_balances(w3, _WALLET, pitch_token=_PITCH, country_addresses=[_BRA, _GER])
        assert bals.eth_wei == 7
        assert bals.pitch_wei == 100
        # Sorted descending by wei: GER (200) then BRA (50).
        assert bals.countries == [(_GER, 200), (_BRA, 50)]

    def test_zero_balance_country_filtered_out(self) -> None:
        returns = [_wei_to_returndata(0), _wei_to_returndata(42)]
        w3 = _make_w3(eth_balance=0, multicall_returns=returns)
        bals = wallet_balances(w3, _WALLET, pitch_token="", country_addresses=[_BRA, _GER])
        # No PITCH targets → first multicall entry is BRA.
        assert bals.countries == [(_GER, 42)]

    def test_failed_call_returns_empty_bytes_treated_as_zero(self) -> None:
        # PITCH success, BRA failed (empty bytes), GER success.
        returns = [_wei_to_returndata(10), b"", _wei_to_returndata(20)]
        w3 = _make_w3(eth_balance=0, multicall_returns=returns)
        bals = wallet_balances(w3, _WALLET, pitch_token=_PITCH, country_addresses=[_BRA, _GER])
        assert bals.pitch_wei == 10
        assert bals.countries == [(_GER, 20)]

    def test_mixed_case_wallet_normalized(self) -> None:
        # Pass mixed-case wallet — internal lc() must lowercase before encoding.
        w3 = _make_w3(eth_balance=1, multicall_returns=[_wei_to_returndata(5)])
        bals = wallet_balances(
            w3,
            _WALLET.upper().replace("0X", "0x"),
            pitch_token=_PITCH,
            country_addresses=[],
        )
        assert bals.pitch_wei == 5
