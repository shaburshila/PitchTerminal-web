"""Unit tests for :mod:`worker.operator_alerts`.

Covers the public surface:

* :func:`send` — POSTs to Telegram with correct payload, no-ops when creds
  unset, swallows HTTP exceptions.
* :func:`record_tick_failure` / :func:`record_tick_success` — single alert
  per failure streak, reset on success.
* :func:`record_price_stale` / :func:`record_price_fresh` — single alert
  when stale, reset on fresh.
* :func:`announce_worker_start` — boot-time alert.

httpx is patched at the module level (``operator_alerts.httpx.post``) and
the credential accessors are patched via ``patch.object`` to bypass the
frozen ``Config`` dataclass.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch

import httpx
import pytest

from worker import operator_alerts


@pytest.fixture(autouse=True)
def _reset_state() -> None:
    """Clear de-dup state between tests so order doesn't matter."""

    operator_alerts._reset_state_for_tests()


@pytest.fixture
def _with_creds() -> Any:
    """Patch credential accessors to return non-empty strings."""

    with (
        patch.object(operator_alerts, "_get_bot_token", return_value="BOT_TOKEN_X"),
        patch.object(operator_alerts, "_get_chat_id", return_value="12345"),
    ):
        yield


class TestSend:
    def test_posts_correct_payload(self, _with_creds: Any) -> None:
        resp = MagicMock()
        resp.status_code = 200
        with patch.object(operator_alerts.httpx, "post", return_value=resp) as p:
            operator_alerts.send("hello world")

        assert p.call_count == 1
        args, kwargs = p.call_args
        assert args[0] == "https://api.telegram.org/botBOT_TOKEN_X/sendMessage"
        assert kwargs["json"] == {"chat_id": "12345", "text": "hello world"}
        assert kwargs["timeout"] == operator_alerts._HTTP_TIMEOUT_SEC

    def test_noop_when_token_empty(self) -> None:
        with (
            patch.object(operator_alerts, "_get_bot_token", return_value=""),
            patch.object(operator_alerts, "_get_chat_id", return_value="12345"),
            patch.object(operator_alerts.httpx, "post") as p,
        ):
            operator_alerts.send("hi")
        assert p.call_count == 0

    def test_noop_when_chat_empty(self) -> None:
        with (
            patch.object(operator_alerts, "_get_bot_token", return_value="BOT"),
            patch.object(operator_alerts, "_get_chat_id", return_value=""),
            patch.object(operator_alerts.httpx, "post") as p,
        ):
            operator_alerts.send("hi")
        assert p.call_count == 0

    def test_swallows_http_exception(self, _with_creds: Any) -> None:
        with patch.object(
            operator_alerts.httpx,
            "post",
            side_effect=httpx.TimeoutException("boom"),
        ):
            # Must not raise.
            operator_alerts.send("hi")

    def test_swallows_generic_exception(self, _with_creds: Any) -> None:
        with patch.object(operator_alerts.httpx, "post", side_effect=RuntimeError("network down")):
            operator_alerts.send("hi")

    def test_logs_warning_on_4xx(self, _with_creds: Any) -> None:
        resp = MagicMock()
        resp.status_code = 401
        resp.text = "unauthorized"
        with patch.object(operator_alerts.httpx, "post", return_value=resp):
            # Doesn't raise even on 4xx.
            operator_alerts.send("hi")


class TestTickFailureDedup:
    def test_no_alert_below_threshold(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            for _ in range(operator_alerts.CONSECUTIVE_FAILURE_THRESHOLD - 1):
                operator_alerts.record_tick_failure("event_loop")
            assert send_mock.call_count == 0

    def test_single_alert_at_threshold(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            for _ in range(operator_alerts.CONSECUTIVE_FAILURE_THRESHOLD):
                operator_alerts.record_tick_failure("event_loop")
            assert send_mock.call_count == 1
            # event-loop name appears in the body.
            body = send_mock.call_args.args[0]
            assert "event_loop" in body

    def test_no_spam_past_threshold(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            for _ in range(operator_alerts.CONSECUTIVE_FAILURE_THRESHOLD + 20):
                operator_alerts.record_tick_failure("event_loop")
            # Still exactly one alert despite 25 failures.
            assert send_mock.call_count == 1

    def test_success_resets_and_emits_recovery(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            for _ in range(operator_alerts.CONSECUTIVE_FAILURE_THRESHOLD):
                operator_alerts.record_tick_failure("event_loop")
            assert send_mock.call_count == 1  # failure alert

            operator_alerts.record_tick_success("event_loop")
            assert send_mock.call_count == 2  # recovery alert
            assert "recovered" in send_mock.call_args.args[0]

            # A new failure streak can re-alert.
            for _ in range(operator_alerts.CONSECUTIVE_FAILURE_THRESHOLD):
                operator_alerts.record_tick_failure("event_loop")
            assert send_mock.call_count == 3

    def test_success_without_prior_alert_silent(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            # A handful of failures, never reaching threshold.
            for _ in range(2):
                operator_alerts.record_tick_failure("event_loop")
            operator_alerts.record_tick_success("event_loop")
            # No alerts at all — neither failure nor recovery.
            assert send_mock.call_count == 0

    def test_loops_isolated(self) -> None:
        """Failures in one loop do not pollute another loop's counter."""

        with patch.object(operator_alerts, "send") as send_mock:
            for _ in range(operator_alerts.CONSECUTIVE_FAILURE_THRESHOLD - 1):
                operator_alerts.record_tick_failure("event_loop")
            for _ in range(operator_alerts.CONSECUTIVE_FAILURE_THRESHOLD - 1):
                operator_alerts.record_tick_failure("price_loop")
            # Neither has reached threshold individually.
            assert send_mock.call_count == 0


class TestPriceStale:
    def test_no_alert_when_never_updated(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            # last_update_ts=0 means "cold worker" — should never alert.
            operator_alerts.record_price_stale(now_ts=10**9, last_update_ts=0)
            assert send_mock.call_count == 0

    def test_no_alert_when_fresh(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            now = 1_700_000_000.0
            operator_alerts.record_price_stale(now_ts=now, last_update_ts=now - 30)
            assert send_mock.call_count == 0

    def test_alert_once_when_stale(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            now = 1_700_000_000.0
            last = now - (operator_alerts.PRICE_STALE_THRESHOLD_SEC + 10)
            # Many consecutive stale checks → still only one alert.
            for _ in range(10):
                operator_alerts.record_price_stale(now_ts=now, last_update_ts=last)
            assert send_mock.call_count == 1
            assert "stale" in send_mock.call_args.args[0]

    def test_fresh_resets_and_emits_recovery(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            now = 1_700_000_000.0
            last = now - (operator_alerts.PRICE_STALE_THRESHOLD_SEC + 10)
            operator_alerts.record_price_stale(now_ts=now, last_update_ts=last)
            assert send_mock.call_count == 1

            operator_alerts.record_price_fresh()
            assert send_mock.call_count == 2
            assert "recovered" in send_mock.call_args.args[0]

            # Re-stale → re-alerts.
            operator_alerts.record_price_stale(now_ts=now, last_update_ts=last)
            assert send_mock.call_count == 3

    def test_fresh_without_prior_alert_silent(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            operator_alerts.record_price_fresh()
            assert send_mock.call_count == 0


class TestAnnounceStart:
    def test_emits_boot_message(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            operator_alerts.announce_worker_start(backfill_complete=True)
            assert send_mock.call_count == 1
            body = send_mock.call_args.args[0]
            assert "worker started" in body
            assert "backfill_complete=True" in body

    def test_emits_with_incomplete_backfill(self) -> None:
        with patch.object(operator_alerts, "send") as send_mock:
            operator_alerts.announce_worker_start(backfill_complete=False)
            body = send_mock.call_args.args[0]
            assert "backfill_complete=False" in body
