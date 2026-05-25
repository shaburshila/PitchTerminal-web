"""Unit tests for :mod:`shared.fee` — execution↔MID price conversions.

The pitchwc bonding-curve charges a flat 5% protocol fee:

* MID is the fee-free curve price (= ``Hook.currentPrice``).
* ASK = MID / 0.95 — what a buyer pays per base.
* BID = MID * 0.95 — what a seller receives per base.

These conversions back the keeper's MID-space trigger evaluation: when an
order is signed before migration 0004 (no ``display_target_price``), the
keeper derives the MID target from the signed execution-space
``target_price`` via :func:`execution_to_mid_wei`.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from shared.fee import (
    FEE_BPS,
    FEE_FACTOR,
    event_price_to_mid,
    execution_to_mid_wei,
    mid_to_execution_wei,
)


class TestConstants:
    def test_fee_bps_default_is_5_percent(self) -> None:
        # The current pitchwc fee; any change requires a coordinated
        # update + re-derivation of NULL display_target_price rows.
        assert FEE_BPS == 500

    def test_fee_factor_matches_bps(self) -> None:
        assert FEE_FACTOR == Decimal(9_500) / Decimal(10_000)


class TestExecutionToMidWei:
    def test_buy_divides_execution_by_fee_factor_inverse(self) -> None:
        # MID = 10 (in 1e18 wei). ASK = MID / 0.95 = 10.526315789...
        mid_wei = 10 * 10**18
        ask_wei = (mid_wei * 10_000) // 9_500  # what frontend signed
        derived = execution_to_mid_wei(ask_wei, "limit-buy")
        # Round-trip should give back MID to 1-wei precision.
        assert abs(derived - mid_wei) <= 1

    def test_sell_multiplies_execution_by_fee_factor(self) -> None:
        # MID = 10. BID = MID * 0.95 = 9.5. Sell-side signed BID; deriving
        # MID should multiply BID by 1/0.95.
        mid_wei = 10 * 10**18
        bid_wei = (mid_wei * 9_500) // 10_000
        derived = execution_to_mid_wei(bid_wei, "take-profit")
        assert abs(derived - mid_wei) <= 1

    def test_accepts_event_side_aliases(self) -> None:
        ask_wei = 10 * 10**18
        assert execution_to_mid_wei(ask_wei, "buy") == execution_to_mid_wei(
            ask_wei, "limit-buy"
        )
        bid_wei = 10 * 10**18
        assert execution_to_mid_wei(bid_wei, "sell") == execution_to_mid_wei(
            bid_wei, "take-profit"
        )

    def test_rejects_zero_and_negative(self) -> None:
        with pytest.raises(ValueError):
            execution_to_mid_wei(0, "limit-buy")
        with pytest.raises(ValueError):
            execution_to_mid_wei(-1, "limit-buy")

    def test_rejects_unknown_side(self) -> None:
        with pytest.raises(ValueError):
            execution_to_mid_wei(10**18, "market")

    def test_large_uint256_value(self) -> None:
        """NUMERIC(78,0) range — integer arithmetic must not overflow."""
        ask = 10**40
        out = execution_to_mid_wei(ask, "limit-buy")
        # MID should be smaller than ASK (since MID = ASK * 0.95).
        assert out < ask
        # And > 90% of ASK.
        assert out > (ask * 9) // 10


class TestMidToExecutionWei:
    def test_buy_round_trip_with_execution_to_mid(self) -> None:
        mid = 1234 * 10**18
        ask = mid_to_execution_wei(mid, "limit-buy")
        # ASK > MID for buy side.
        assert ask > mid
        # Round-trip back to MID within 1 wei.
        recovered = execution_to_mid_wei(ask, "limit-buy")
        assert abs(recovered - mid) <= 1

    def test_sell_round_trip(self) -> None:
        mid = 1234 * 10**18
        bid = mid_to_execution_wei(mid, "take-profit")
        # BID < MID for sell side.
        assert bid < mid
        recovered = execution_to_mid_wei(bid, "take-profit")
        assert abs(recovered - mid) <= 1


class TestEventPriceToMid:
    def test_buy_scales_by_fee_factor(self) -> None:
        # Execution rate 10.526 (in display units) → MID = 10.
        ask_display = Decimal("10.5263157894736842")
        mid = event_price_to_mid(ask_display, "buy")
        assert abs(mid - Decimal("10")) < Decimal("1e-9")

    def test_sell_scales_by_inverse_factor(self) -> None:
        # Execution rate 9.5 (BID) → MID = 10.
        bid_display = Decimal("9.5")
        mid = event_price_to_mid(bid_display, "sell")
        assert mid == Decimal("10")

    def test_accepts_float(self) -> None:
        mid = event_price_to_mid(9.5, "sell")
        assert abs(mid - Decimal("10")) < Decimal("1e-9")

    def test_rejects_non_positive(self) -> None:
        with pytest.raises(ValueError):
            event_price_to_mid(Decimal("0"), "buy")
