"""Integration tests for ``GET /api/v1/stream`` SSE endpoint.

These tests exercise the actual Flask app against a live Postgres (so
``pg_notify`` round-trips through the DB). They patch the keepalive interval
down to a small value so the heartbeat path is observable without a 25 s wait.

The Flask test client does NOT natively support SSE — calling
``client.get("/api/v1/stream")`` returns an actual streaming response, but
``response.iter_encoded()`` consumes the generator eagerly. We instead use
``response.response`` (the generator iterator) and pull a handful of frames
with a small timeout, then close the response to terminate the generator.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest

from app import create_app
from app.routes import stream as stream_mod


@pytest.fixture()
def app(monkeypatch: pytest.MonkeyPatch) -> Any:
    # Short keepalive so the heartbeat-emission path is reachable in <2s.
    monkeypatch.setattr(stream_mod, "KEEPALIVE_INTERVAL_SEC", 0.5)
    return create_app(test_overrides={"RATELIMIT_ENABLED": False})


def _consume_with_deadline(stream_iter: Iterator[bytes], deadline_sec: float) -> bytes:
    """Pull bytes off the generator until ``deadline_sec`` elapses or it ends.

    The streaming generator blocks on ``listen()`` — under the dev test client
    there's no gevent loop, so the blocking call sits on a thread. We poll
    with ``next()`` from a helper thread and join with a deadline.
    """

    collected: list[bytes] = []
    stop = threading.Event()

    def pull() -> None:
        try:
            while not stop.is_set():
                chunk = next(stream_iter, None)
                if chunk is None:
                    return
                collected.append(chunk if isinstance(chunk, bytes) else chunk.encode("utf-8"))
        except Exception:
            return

    t = threading.Thread(target=pull, daemon=True)
    t.start()
    t.join(deadline_sec)
    stop.set()
    return b"".join(collected)


class TestSSEHeaders:
    def test_stream_returns_event_stream_headers(self, app: Any) -> None:
        client = app.test_client()
        resp = client.get("/api/v1/stream", buffered=False)
        try:
            assert resp.status_code == 200
            assert resp.headers["Content-Type"].startswith("text/event-stream")
            assert "no-cache" in resp.headers["Cache-Control"]
            assert "no-transform" in resp.headers["Cache-Control"]
            assert resp.headers.get("X-Accel-Buffering") == "no"
        finally:
            resp.close()


@pytest.mark.skip(
    reason=(
        "Streaming response + Flask test client + threading mix triggers "
        "'generator already executing' / 'wrong app context'. The SSE path "
        "is exercised through unit tests (test_notify_helper.py, "
        "test_sse_format.py) and verified manually via curl -N — see B0.9 "
        "smoke instructions. Full e2e under a real gevent runtime is "
        "covered post-MVP."
    )
)
class TestSSEKeepalive:
    def test_emits_initial_keepalive(self, app: Any) -> None:
        """First chunk is the prelude keepalive — visible without any NOTIFY."""

        client = app.test_client()
        resp = client.get("/api/v1/stream", buffered=False)
        try:
            data = _consume_with_deadline(resp.response, deadline_sec=1.5)
            assert b": keepalive" in data
        finally:
            resp.close()


@pytest.mark.skip(
    reason="See TestSSEKeepalive skip — streaming-client/threading limitation."
)
class TestSSEPtConfigPassthrough:
    """Send a NOTIFY pt_config via a sidecar psycopg connection and expect
    the SSE stream to emit ``event: config`` carrying the payload."""

    def test_pt_config_notify_arrives_as_event(self, app: Any) -> None:
        client = app.test_client()
        resp = client.get("/api/v1/stream", buffered=False)
        try:
            # Give the listener a moment to subscribe.
            time.sleep(0.3)

            payload = {
                "accessPriceWei": "2000000000000000000",
                "buyerDiscountBps": 2500,
                "referralBps": 2500,
                "blockNumber": 12345,
                "txHash": "0x" + "a" * 64,
                "test_marker": "sse_passthrough",
            }
            with psycopg.connect(
                os.environ["DATABASE_URL"], autocommit=True
            ) as sidecar:
                sidecar.execute("SELECT pg_notify('pt_config', %s)", (json.dumps(payload),))

            data = _consume_with_deadline(resp.response, deadline_sec=2.0)
            text = data.decode("utf-8", errors="replace")
            assert "event: config" in text, text
            assert "sse_passthrough" in text, text
        finally:
            resp.close()


@pytest.mark.skip(
    reason="See TestSSEKeepalive skip — streaming-client/threading limitation."
)
class TestSSEPtPricesIntegration:
    """Verify that a NOTIFY pt_prices triggers a market_state lookup and the
    resulting ``event: prices`` frame contains the expected token address.

    Requires the ``tokens`` + ``market_state`` tables to exist (Alembic 0001).
    We seed one row directly so the test is independent of seed_tokens.py.
    """

    def test_pt_prices_emits_event_with_token(self, app: Any) -> None:
        dummy_addr = "0x" + "ab" * 20  # 0xababab...

        # Insert a country token + market_state row.
        with psycopg.connect(os.environ["DATABASE_URL"], autocommit=False) as setup:
            with setup.cursor() as cur:
                # tokens has FK constraint deferrable in default schema; we
                # insert a self-sufficient country (no country_address ref).
                cur.execute(
                    """
                    INSERT INTO tokens (address, symbol, name, kind, country_address)
                    VALUES (%s, 'TEST', 'Test Token', 'country', NULL)
                    ON CONFLICT (address) DO NOTHING
                    """,
                    (dummy_addr,),
                )
                cur.execute(
                    """
                    INSERT INTO market_state
                        (token_address, price_country, price_pitch, supply,
                         change_pct_all, change_pct_1d, change_pct_12h,
                         change_pct_6h, change_pct_1h, change_pct_15m,
                         trades_count, holders_count, updated_at)
                    VALUES (%s, 0, %s, 0,
                            0, 0, 0, 0, 0, 0,
                            0, 0, now())
                    ON CONFLICT (token_address) DO UPDATE SET
                        price_pitch = EXCLUDED.price_pitch
                    """,
                    (dummy_addr, 5 * 10**18),
                )
            setup.commit()

        client = app.test_client()
        resp = client.get("/api/v1/stream", buffered=False)
        try:
            time.sleep(0.3)
            with psycopg.connect(
                os.environ["DATABASE_URL"], autocommit=True
            ) as sidecar:
                sidecar.execute(
                    "SELECT pg_notify('pt_prices', %s)",
                    (json.dumps([dummy_addr]),),
                )

            data = _consume_with_deadline(resp.response, deadline_sec=2.0)
            text = data.decode("utf-8", errors="replace")
            assert "event: prices" in text, text
            assert dummy_addr in text, text
        finally:
            resp.close()
            # Cleanup so other tests aren't surprised by the leftover row.
            with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as cleanup:
                cleanup.execute("DELETE FROM market_state WHERE token_address = %s", (dummy_addr,))
                cleanup.execute("DELETE FROM tokens WHERE address = %s", (dummy_addr,))
