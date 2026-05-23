"""Unit tests for :mod:`shared.price`.

Test vectors mirror the portable ``_market_price`` semantics — these numbers
must keep working bit-for-bit if the formula ever changes, because
``rebuild_market_state`` depends on them (see ``docs/port-from-portable.md``
§5.1).
"""

from __future__ import annotations

from shared.config import WEI
from shared.price import current_price_of, market_price, to_display_units


class TestMarketPrice:
    def test_buy_subtracts_fee(self) -> None:
        # base=105 PITCH, fee=5 PITCH, got 10 tokens → curve price 100/10 = 10.
        base = 105 * WEI
        fee = 5 * WEI
        tokens = 10 * WEI
        assert market_price("buy", base, fee, tokens) == 10.0

    def test_sell_adds_fee(self) -> None:
        # base=95 PITCH net of fee, fee=5 → curve received 100 for 10 tokens.
        base = 95 * WEI
        fee = 5 * WEI
        tokens = 10 * WEI
        assert market_price("sell", base, fee, tokens) == 10.0

    def test_buy_fractional(self) -> None:
        # 1.5 PITCH net for 3 tokens → 0.5 each.
        base = (15 * WEI) // 10  # 1.5
        fee = 0
        tokens = 3 * WEI
        assert market_price("buy", base, fee, tokens) == 0.5

    def test_zero_token_returns_zero(self) -> None:
        # Defensive: should never happen on real events but must not crash.
        assert market_price("buy", 100 * WEI, 5 * WEI, 0) == 0.0
        assert market_price("sell", 100 * WEI, 5 * WEI, 0) == 0.0

    def test_negative_token_returns_zero(self) -> None:
        assert market_price("buy", 100, 5, -1) == 0.0

    def test_precision_with_large_numbers(self) -> None:
        # Verify Decimal precision: 10**30 wei / 10**18 wei = 10**12.
        base = 10**30
        tokens = 10**18
        assert market_price("buy", base, 0, tokens) == float(10**12)


class TestCurrentPriceOf:
    def test_multiplies_components(self) -> None:
        # player priced 2 country-tokens, country priced 5 PITCH → 10 PITCH.
        assert current_price_of(2.0, 5.0) == 10.0

    def test_zero_player_price_returns_zero(self) -> None:
        assert current_price_of(0.0, 5.0) == 0.0

    def test_zero_country_price_returns_zero(self) -> None:
        assert current_price_of(2.0, 0.0) == 0.0

    def test_negative_inputs_return_zero(self) -> None:
        assert current_price_of(-1.0, 5.0) == 0.0
        assert current_price_of(2.0, -5.0) == 0.0


class TestToDisplayUnits:
    def test_exact_wei(self) -> None:
        assert to_display_units(WEI) == 1.0

    def test_half_wei(self) -> None:
        assert to_display_units(WEI // 2) == 0.5

    def test_zero(self) -> None:
        assert to_display_units(0) == 0.0

    def test_large_value(self) -> None:
        assert to_display_units(10**21) == 1000.0
