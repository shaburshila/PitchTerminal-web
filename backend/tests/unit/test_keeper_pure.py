"""Pure-function unit tests for :mod:`worker.keeper` (B2.3).

These tests cover the side-effect-free helpers:

* :func:`worker.keeper.should_trigger` — the trigger predicate the keeper
  applies before bothering with simulation / submission.
* :func:`worker.keeper.decode_revert_reason` — selector→enum mapping that
  feeds ``limit_orders.fail_reason``.
* :func:`worker.keeper.is_retryable_label` — splits "price moved" failures
  (cooldown + retry) from terminal failures (mark failed).

No DB, no RPC — purely logical. The integration test for the full tick
loop lives in ``tests/integration/test_keeper.py``.
"""

from __future__ import annotations

from web3 import Web3

from worker.keeper import (
    decode_revert_reason,
    is_retryable_label,
    should_trigger,
)


class TestShouldTrigger:
    def test_no_market_price_never_triggers(self) -> None:
        assert should_trigger("limit-buy", target_price=100, market_price=0).triggers is False
        assert should_trigger("take-profit", target_price=100, market_price=0).triggers is False
        # Negative is defensive; market_state can't go below 0 but we
        # don't want NaN-style false positives if a caller passes garbage.
        assert should_trigger("limit-buy", target_price=100, market_price=-5).triggers is False

    def test_limit_buy_triggers_when_market_below_or_equal_target(self) -> None:
        # Strictly below — triggers.
        d = should_trigger("limit-buy", target_price=100, market_price=80)
        assert d.triggers is True
        assert "below_target" in d.reason

        # Exactly equal — still triggers (spec: market <= target).
        d = should_trigger("limit-buy", target_price=100, market_price=100)
        assert d.triggers is True

        # Above target — does not trigger.
        d = should_trigger("limit-buy", target_price=100, market_price=120)
        assert d.triggers is False
        assert "above_target" in d.reason

    def test_take_profit_triggers_when_market_above_or_equal_target(self) -> None:
        d = should_trigger("take-profit", target_price=100, market_price=120)
        assert d.triggers is True
        assert "above_target" in d.reason

        d = should_trigger("take-profit", target_price=100, market_price=100)
        assert d.triggers is True

        d = should_trigger("take-profit", target_price=100, market_price=80)
        assert d.triggers is False
        assert "below_target" in d.reason

    def test_unknown_side_does_not_trigger(self) -> None:
        d = should_trigger("market", target_price=100, market_price=120)
        assert d.triggers is False
        assert "unknown_side" in d.reason

    def test_large_uint256_values(self) -> None:
        """The DB stores wei in NUMERIC(78,0); pure Python ints handle this fine."""

        target = 10**40
        market = target - 1
        assert should_trigger("limit-buy", target, market).triggers is True
        assert should_trigger("take-profit", target, market).triggers is False
        assert should_trigger("take-profit", target, target + 1).triggers is True


class TestDecodeRevertReason:
    @staticmethod
    def _selector(sig: str) -> str:
        """Return the 4-byte selector hex for a Solidity error signature."""

        return "0x" + Web3.keccak(text=sig)[:4].hex()

    def test_decodes_price_condition_not_met_as_retryable(self) -> None:
        sel = self._selector("PriceConditionNotMet()")
        reason, label = decode_revert_reason(sel)
        # PriceConditionNotMet is the canonical "price moved" cooldown case.
        assert label == "PriceConditionNotMet"
        assert reason == "router_revert"
        assert is_retryable_label(label) is True

    def test_decodes_insufficient_output_as_retryable(self) -> None:
        sel = self._selector("InsufficientOutput()")
        reason, label = decode_revert_reason(sel)
        assert label == "InsufficientOutput"
        assert reason == "min_out_not_met"
        assert is_retryable_label(label) is True

    def test_decodes_nonce_already_used_as_terminal(self) -> None:
        sel = self._selector("NonceAlreadyUsed()")
        reason, label = decode_revert_reason(sel)
        assert label == "NonceAlreadyUsed"
        assert reason == "nonce_used"
        assert is_retryable_label(label) is False

    def test_decodes_order_expired(self) -> None:
        sel = self._selector("OrderExpired()")
        reason, label = decode_revert_reason(sel)
        assert label == "OrderExpired"
        assert reason == "expired_on_chain"
        assert is_retryable_label(label) is False

    def test_decodes_invalid_quote_token(self) -> None:
        sel = self._selector("InvalidQuoteToken()")
        reason, label = decode_revert_reason(sel)
        assert label == "InvalidQuoteToken"
        assert reason == "bad_quote_token"

    def test_unknown_selector_returns_unknown(self) -> None:
        # A made-up selector that doesn't match any Executor error.
        reason, label = decode_revert_reason("0xdeadbeef")
        assert reason == "unknown"
        assert label is None

    def test_substring_fallback_when_no_selector(self) -> None:
        """web3.py sometimes hands us the human revert string, not the hex."""

        reason, label = decode_revert_reason("execution reverted: NonceAlreadyUsed")
        assert label == "NonceAlreadyUsed"
        assert reason == "nonce_used"

    def test_empty_revert_data(self) -> None:
        reason, label = decode_revert_reason("0x")
        assert reason == "unknown"
        assert label is None

    def test_case_insensitive_selector_match(self) -> None:
        """RPCs send mixed-case hex; the matcher must absorb both."""

        sel = self._selector("PriceConditionNotMet()").upper()
        reason, label = decode_revert_reason(sel)
        assert label == "PriceConditionNotMet"
        assert reason == "router_revert"

    def test_selector_embedded_in_longer_payload(self) -> None:
        """Selector at the head of revert data, with appended (empty) args."""

        sel = self._selector("PriceConditionNotMet()")
        # No abi-encoded args for a parameter-less custom error; the head
        # is the whole payload.
        reason, _label = decode_revert_reason(sel + "")
        assert reason == "router_revert"


class TestIsRetryableLabel:
    def test_retryable_labels(self) -> None:
        assert is_retryable_label("PriceConditionNotMet") is True
        assert is_retryable_label("InsufficientOutput") is True

    def test_terminal_labels(self) -> None:
        assert is_retryable_label("NonceAlreadyUsed") is False
        assert is_retryable_label("OrderExpired") is False
        assert is_retryable_label("InvalidQuoteToken") is False

    def test_none_label_is_terminal(self) -> None:
        # Unknown/empty revert → no label → not retryable, mark failed.
        assert is_retryable_label(None) is False
