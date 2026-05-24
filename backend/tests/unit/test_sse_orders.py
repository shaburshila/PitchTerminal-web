"""Unit tests for the SSE ``pt_orders`` premium channel (B2.2).

We can't drive the full streaming generator under the Flask test client (see
``tests/integration/test_sse_stream.py`` skip-rationale — streaming response +
threading is fragile). Instead, we exercise the pure handler-helpers that the
generator calls on each NOTIFY:

* ``_parse_order_id`` — payload decoding.
* ``_fetch_order_for_owner`` — DB-row lookup + ownership filter (this is the
  critical security boundary — non-owners must NOT see other users' orders).

The end-to-end "premium connects → POSTs order → sees event" path is verified
manually with ``curl -N`` per the B0.9 / B2.2 smoke recipe.
"""

from __future__ import annotations

import contextlib
from typing import Any
from unittest.mock import patch

from app.routes import stream as stream_mod


class TestParseOrderId:
    def test_int_payload_parsed(self) -> None:
        assert stream_mod._parse_order_id("123") == 123

    def test_whitespace_tolerated(self) -> None:
        assert stream_mod._parse_order_id("  42 \n") == 42

    def test_bad_payload_returns_none(self) -> None:
        assert stream_mod._parse_order_id("not-a-number") is None

    def test_empty_payload_returns_none(self) -> None:
        assert stream_mod._parse_order_id("") is None


class TestFetchOrderForOwner:
    """Ownership filter — the security-critical part of B2.2.

    We patch :func:`app.routes.stream.fetch_one` to control the row shape
    without a live DB.
    """

    _OWNER = "0x" + "11" * 20
    _OTHER = "0x" + "22" * 20

    def _row(
        self,
        *,
        owner: str,
        order_id: int = 7,
        status: str = "pending",
        tx_hash: str | None = None,
        fail_reason: str | None = None,
        updated_at_ts: int = 1_700_000_000,
    ) -> dict[str, Any]:
        return {
            "id": order_id,
            "owner_address": owner.ljust(42),  # CHAR(42) pad — mimic DB return.
            "status": status,
            "executed_tx_hash": tx_hash.ljust(66) if tx_hash else None,
            "fail_reason": fail_reason,
            "updated_at_ts": updated_at_ts,
        }

    def test_owner_match_returns_payload(self) -> None:
        row = self._row(owner=self._OWNER)
        with patch.object(stream_mod, "fetch_one", return_value=row):
            out = stream_mod._fetch_order_for_owner(7, self._OWNER)
        assert out is not None
        assert out == {
            "order": {
                "id": "7",
                "status": "pending",
                "executedTxHash": None,
                "failReason": None,
                "updatedAt": 1_700_000_000,
            }
        }

    def test_owner_mismatch_returns_none(self) -> None:
        """Non-owner MUST NOT see another user's order (no info leak)."""

        row = self._row(owner=self._OTHER)
        with patch.object(stream_mod, "fetch_one", return_value=row):
            out = stream_mod._fetch_order_for_owner(7, self._OWNER)
        assert out is None

    def test_missing_row_returns_none(self) -> None:
        with patch.object(stream_mod, "fetch_one", return_value=None):
            out = stream_mod._fetch_order_for_owner(7, self._OWNER)
        assert out is None

    def test_payload_excludes_signature(self) -> None:
        """Signature must never leak to the SSE client (security)."""

        row = self._row(
            owner=self._OWNER,
            status="filled",
            tx_hash="0x" + "ab" * 32,
        )
        with patch.object(stream_mod, "fetch_one", return_value=row):
            out = stream_mod._fetch_order_for_owner(7, self._OWNER)
        assert out is not None
        # No 'signature' key anywhere in the payload.
        flat = str(out)
        assert "signature" not in flat
        assert out["order"]["executedTxHash"] == "0x" + "ab" * 32

    def test_case_insensitive_owner_match(self) -> None:
        """JWT addresses are normalized to lowercase; row owner is also lowercase
        but the helper must tolerate accidental case mismatch."""

        row = self._row(owner=self._OWNER.upper())
        with patch.object(stream_mod, "fetch_one", return_value=row):
            out = stream_mod._fetch_order_for_owner(7, self._OWNER.lower())
        assert out is not None


class TestPremiumChannelSelection:
    """Verify that ``_stream_generator`` opens an extra LISTEN for ``pt_orders``
    only when ``premium_owner`` is set.

    We mock :class:`shared.notify.Listener` so no real Postgres connection is
    opened — we just record the channels passed to the constructor.
    """

    @staticmethod
    def _make_fake_listener_class(
        captured: dict[str, Any],
    ) -> type:
        """Build a fake Listener that records channels and raises StopAbort on
        first ``listen()`` so the generator exits the while-True without spin."""

        class _StopAbort(Exception):
            pass

        captured["StopAbort"] = _StopAbort

        class _FakeListener:
            def __init__(self, channels: list[str]) -> None:
                captured["channels"] = channels

            def __enter__(self) -> _FakeListener:
                return self

            def __exit__(self, *args: Any) -> None:
                pass

            def listen(self, timeout: float | None = None) -> Any:
                # Raise immediately so the generator's outer try/except logs
                # and returns — channels are captured at __init__, which is
                # what we're asserting on.
                raise _StopAbort()

        return _FakeListener

    def test_anonymous_no_orders_channel(self) -> None:
        captured: dict[str, Any] = {}
        fake_cls = self._make_fake_listener_class(captured)

        with patch.object(stream_mod, "Listener", fake_cls):
            gen = stream_mod._stream_generator(premium_owner=None)
            # Drain prelude + drive generator to the Listener instantiation.
            assert next(gen).startswith(": keepalive")
            # Next iteration enters `with Listener(...)`, then listener.listen
            # raises _StopAbort → the generator's outer except logs and returns
            # → StopIteration on the caller side.
            with contextlib.suppress(StopIteration):
                next(gen)

        assert captured["channels"] == ["pt_prices", "pt_events", "pt_config"]

    def test_premium_includes_orders_channel(self) -> None:
        captured: dict[str, Any] = {}
        fake_cls = self._make_fake_listener_class(captured)

        with patch.object(stream_mod, "Listener", fake_cls):
            gen = stream_mod._stream_generator(premium_owner="0x" + "ab" * 20)
            assert next(gen).startswith(": keepalive")
            with contextlib.suppress(StopIteration):
                next(gen)

        assert "pt_orders" in captured["channels"]
        assert captured["channels"] == [
            "pt_prices",
            "pt_events",
            "pt_config",
            "pt_orders",
        ]
