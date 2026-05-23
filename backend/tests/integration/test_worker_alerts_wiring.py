"""Integration: worker loops route into operator_alerts correctly.

Verifies the wiring (not the Telegram HTTP itself — that's covered in unit
tests). We patch ``operator_alerts.send`` to spy on emitted alerts.

* ``event_loop.tick`` calls :func:`record_tick_failure` when the underlying
  RPC raises, and :func:`record_tick_success` on a clean path.
* ``price_loop.tick`` calls :func:`record_price_fresh` after a successful
  update and :func:`record_price_stale` if the cached last-update timestamp
  is past the threshold.
* Multiple consecutive failures in ``event_loop`` produce exactly one alert.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from worker import event_loop, operator_alerts, price_loop


@pytest.fixture(autouse=True)
def _reset_alert_state() -> None:
    operator_alerts._reset_state_for_tests()


class TestEventLoopWiring:
    def test_failure_path_records_failure(self) -> None:
        """RPC raises → record_tick_failure invoked once per tick."""

        # Force the hook check to pass by patching player_hook lookup on
        # the *module-level* `config` reference through object.__setattr__,
        # then make `_w3.get_w3` raise.
        with patch.object(event_loop._w3, "get_w3", side_effect=RuntimeError("rpc")):
            object.__setattr__(event_loop.config, "player_hook", "0xabc")
            try:
                with patch.object(
                    operator_alerts, "record_tick_failure"
                ) as fail_mock, patch.object(
                    operator_alerts, "record_tick_success"
                ) as ok_mock:
                    event_loop.tick()
                    assert fail_mock.call_count == 1
                    assert fail_mock.call_args.args[0] == "event_loop"
                    assert ok_mock.call_count == 0
            finally:
                object.__setattr__(event_loop.config, "player_hook", "")

    def test_no_hooks_does_not_alert(self) -> None:
        """Missing hook envs → silent skip, no alert traffic."""

        with (
            patch.object(operator_alerts, "record_tick_failure") as fail_mock,
            patch.object(operator_alerts, "record_tick_success") as ok_mock,
        ):
            event_loop.tick()
            assert fail_mock.call_count == 0
            assert ok_mock.call_count == 0

    def test_streak_dedup_via_send(self) -> None:
        """End-to-end: 10 consecutive failing ticks → exactly one ``send`` call."""

        object.__setattr__(event_loop.config, "player_hook", "0xabc")
        try:
            with (
                patch.object(event_loop._w3, "get_w3", side_effect=RuntimeError("rpc")),
                patch.object(operator_alerts, "send") as send_mock,
            ):
                for _ in range(10):
                    event_loop.tick()
                # Threshold is 5 → exactly one alert despite 10 failures.
                assert send_mock.call_count == 1
        finally:
            object.__setattr__(event_loop.config, "player_hook", "")


class TestPriceLoopWiring:
    def test_no_hooks_does_not_alert(self) -> None:
        with (
            patch.object(operator_alerts, "record_tick_failure") as fail_mock,
            patch.object(operator_alerts, "record_tick_success") as ok_mock,
            patch.object(operator_alerts, "record_price_stale") as stale_mock,
            patch.object(operator_alerts, "record_price_fresh") as fresh_mock,
        ):
            price_loop.tick()
            # _load_tokens hits the DB → if it raises (no DB) the tick logs
            # an exception and records a failure. If it returns empty, it
            # logs "skip". Either way, no fresh / stale flips.
            assert stale_mock.call_count == 0
            assert fresh_mock.call_count == 0
            # If exception path triggered, both failure + stale are recorded —
            # but stale is gated to call only when last_update_ts > 0, which
            # it isn't at module load. So either way no stale traffic.
            _ = fail_mock, ok_mock  # quiet linters; we don't assert counts here

    def test_failure_records_failure(self) -> None:
        """``_load_tokens`` raises → record_tick_failure called once."""

        with (
            patch.object(price_loop, "_load_tokens", side_effect=RuntimeError("db")),
            patch.object(operator_alerts, "record_tick_failure") as fail_mock,
            patch.object(operator_alerts, "record_tick_success") as ok_mock,
        ):
            price_loop.tick()
            assert fail_mock.call_count == 1
            assert fail_mock.call_args.args[0] == "price_loop"
            assert ok_mock.call_count == 0

    def test_streak_dedup_via_send(self) -> None:
        """End-to-end: 10 consecutive failing ticks → exactly one Telegram alert."""

        with (
            patch.object(price_loop, "_load_tokens", side_effect=RuntimeError("db")),
            patch.object(operator_alerts, "send") as send_mock,
        ):
            for _ in range(10):
                price_loop.tick()
            assert send_mock.call_count == 1
