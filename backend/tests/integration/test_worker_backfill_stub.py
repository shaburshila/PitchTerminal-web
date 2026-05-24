"""Integration tests for :mod:`worker.backfill` (B0.7 — real historical scan).

Replaces the B0.6 stub-only tests. We exercise:

* Skip when already complete (real, not stub).
* Re-run when previous state was the B0.6 stub.
* Resume from ``progressBlock`` after an abort.
* Empty-hook env → mark complete with ``empty_env=True``.
* Chunked scan inserts events and updates ``backfill_status``.
* Exponential backoff on transient RPC errors.
* Graceful abort after persistent RPC errors.
* "Range too large" fallback to ``CHUNK_BLOCKS_FALLBACK``.

We monkey-patch:

* ``worker._w3.get_w3`` — returns a fake ``w3`` exposing
  ``eth.block_number`` / ``eth.get_block``.
* ``worker.backfill.shared_events.scan_logs`` — synthesizes decoded events.
* ``worker.backfill._sleep`` — no-op so backoff doesn't slow tests down.

All tests run against the real Postgres from ``conftest.py`` (skipped if
unreachable) and clean ``app_state.backfill_status`` + ``events`` up-front.
"""

from __future__ import annotations

import dataclasses
import os
from collections.abc import Iterator
from itertools import pairwise
from typing import Any

import psycopg
import pytest

from shared.config import HOOK_DEPLOY_BLOCK
from worker import _w3, backfill, state


def _patch_cfg(monkeypatch: pytest.MonkeyPatch, **overrides: Any) -> None:
    """``shared.config.config`` is a frozen dataclass — patch by replacing the
    module-level binding with a copy that has the desired field overrides."""

    monkeypatch.setattr(backfill, "config", dataclasses.replace(backfill.config, **overrides))


# ───── Fixtures ────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _reset_state() -> Iterator[None]:
    """Wipe backfill_status, last_scanned_block, and events before each test.

    Also seed a single synthetic token (``0x33…33``) used by ``_make_event``
    so the events.events_token_address_fkey doesn't reject the fake rows.
    The integration ``conftest._clean_tokens_table`` truncates ``tokens``
    before each test, so we re-insert our placeholder here AFTER the truncate.
    """

    fake_token = "0x" + "33" * 20
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM app_state WHERE key IN ('backfill_status', 'last_scanned_block')")
        cur.execute("DELETE FROM events")
        # Seed a placeholder country so the FK on `events.token_address` resolves.
        cur.execute(
            "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
            "VALUES (%s, 'FakeCountry', 'FAKE', 'country', NULL, NULL) "
            "ON CONFLICT (address) DO NOTHING",
            (fake_token,),
        )
        conn.commit()
    _w3.reset()
    yield
    _w3.reset()


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """Speed up backoff loops: skip the actual sleep."""

    monkeypatch.setattr(backfill, "_sleep", lambda _s: None)


@pytest.fixture
def _force_hooks(monkeypatch: pytest.MonkeyPatch) -> None:
    """Pretend PLAYER_HOOK and COUNTRY_HOOK are configured."""

    _patch_cfg(
        monkeypatch,
        player_hook="0x" + "11" * 20,
        country_hook="0x" + "22" * 20,
    )


# ───── Fake web3 ───────────────────────────────────────────────────────────


class _FakeBlock:
    def __init__(self, ts: int) -> None:
        self.timestamp = ts


class _FakeEth:
    def __init__(self, head: int) -> None:
        self.block_number = head

    def get_block(self, n: int) -> _FakeBlock:
        # Deterministic synthetic timestamp.
        return _FakeBlock(1_700_000_000 + int(n))


class _FakeW3:
    def __init__(self, head: int) -> None:
        self.eth = _FakeEth(head)


def _install_fake_w3(monkeypatch: pytest.MonkeyPatch, head: int) -> None:
    monkeypatch.setattr(_w3, "get_w3", lambda: _FakeW3(head))


def _make_event(block: int, log_index: int, side: str = "buy") -> dict[str, Any]:
    """Construct a single decoded-event dict matching shared.events.decode_log."""

    return {
        "block_number": block,
        "tx_hash": "0x" + f"{block:064x}",
        "log_index": log_index,
        "token_address": "0x" + "33" * 20,
        "side": side,
        "trader_address": "0x" + "44" * 20,
        "base_value": 1_000_000_000_000_000_000,
        "token_value": 2_000_000_000_000_000_000,
        "fee": 50_000_000_000_000_000,
        "timestamp": 0,
    }


# ───── Tests ───────────────────────────────────────────────────────────────


def test_backfill_skip_if_complete_real(monkeypatch: pytest.MonkeyPatch) -> None:
    """If a real (non-stub) complete status is present, do nothing."""

    state.set_json_key(
        "backfill_status",
        {"complete": True, "stub": False, "events_inserted": 0},
    )

    called: list[bool] = []
    monkeypatch.setattr(
        _w3,
        "get_w3",
        lambda: (called.append(True), _FakeW3(HOOK_DEPLOY_BLOCK + 10))[1],
    )

    backfill.run_if_needed()

    # Untouched.
    blob = state.get_json_key("backfill_status")
    assert blob == {"complete": True, "stub": False, "events_inserted": 0}
    assert called == [], "w3 should not be accessed when already complete"


def test_backfill_runs_if_stub_was_set(monkeypatch: pytest.MonkeyPatch, _force_hooks: None) -> None:
    """B0.6 stub state must trigger a real backfill overriding the stub."""

    # Simulate B0.6 leftover: stub complete + pinned live cursor 100 blocks ahead.
    pinned = HOOK_DEPLOY_BLOCK + 100
    state.set_int_key("last_scanned_block", pinned)
    state.set_json_key(
        "backfill_status",
        {"complete": True, "stub": True, "pinned_to": pinned},
    )

    _install_fake_w3(monkeypatch, head=pinned + 50)

    # Return one event in the middle of the range.
    def fake_scan(*_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        return [_make_event(HOOK_DEPLOY_BLOCK + 10, 0)]

    monkeypatch.setattr(backfill.shared_events, "scan_logs", fake_scan)

    backfill.run_if_needed()

    blob = state.get_json_key("backfill_status")
    assert blob is not None
    assert blob["complete"] is True
    assert blob.get("stub") is False
    assert blob["from_block"] == HOOK_DEPLOY_BLOCK
    # to_block is pinned-1 (live cursor owns ≥ pinned).
    assert blob["to_block"] == pinned - 1
    assert blob["events_inserted"] >= 1


def test_backfill_resumes_from_progress_block(
    monkeypatch: pytest.MonkeyPatch, _force_hooks: None
) -> None:
    """Aborted-prior-run state → continue from progressBlock + 1."""

    progress = HOOK_DEPLOY_BLOCK + 500
    end = HOOK_DEPLOY_BLOCK + 1000
    state.set_json_key(
        "backfill_status",
        {
            "complete": False,
            "from_block": HOOK_DEPLOY_BLOCK,
            "to_block": end,
            "progressBlock": progress,
            "events_inserted": 7,
        },
    )

    _install_fake_w3(monkeypatch, head=end + 100)

    seen_starts: list[int] = []

    def fake_scan(
        _w3: Any,
        _hooks: list[str],
        from_block: int,
        _to_block: int,
        *,
        chunk_size: int = 0,
    ) -> list[dict[str, Any]]:
        seen_starts.append(from_block)
        return []

    monkeypatch.setattr(backfill.shared_events, "scan_logs", fake_scan)

    backfill.run_if_needed()

    assert seen_starts, "scan_logs must be called at least once"
    assert seen_starts[0] == progress + 1
    blob = state.get_json_key("backfill_status")
    assert blob is not None
    assert blob["complete"] is True
    assert blob["events_inserted"] == 7  # carried over since fake_scan returned nothing


def test_backfill_handles_empty_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both hooks empty → mark complete with empty_env=True, never call w3."""

    _patch_cfg(monkeypatch, player_hook="", country_hook="")

    touched: list[bool] = []
    monkeypatch.setattr(_w3, "get_w3", lambda: (touched.append(True), _FakeW3(0))[1])

    backfill.run_if_needed()

    blob = state.get_json_key("backfill_status")
    assert blob is not None
    assert blob["complete"] is True
    assert blob.get("empty_env") is True
    assert touched == []


def test_backfill_chunks_correctly(monkeypatch: pytest.MonkeyPatch, _force_hooks: None) -> None:
    """A multi-chunk run inserts every event and updates cumulative counter."""

    # Force a small chunk so we exercise multiple iterations.
    _patch_cfg(monkeypatch, chunk_blocks_default=100, chunk_blocks_fallback=50)

    head = HOOK_DEPLOY_BLOCK + 250  # → ~3 chunks of 100
    _install_fake_w3(monkeypatch, head=head + 5)

    counter = {"i": 0}

    def fake_scan(
        _w3: Any,
        _hooks: list[str],
        from_block: int,
        to_block: int,
        *,
        chunk_size: int = 0,
    ) -> list[dict[str, Any]]:
        # 1 event per chunk, unique log_index across chunks.
        counter["i"] += 1
        return [_make_event(from_block, counter["i"])]

    monkeypatch.setattr(backfill.shared_events, "scan_logs", fake_scan)

    backfill.run_if_needed()

    blob = state.get_json_key("backfill_status")
    assert blob is not None
    assert blob["complete"] is True
    # 3 chunks → 3 events inserted.
    assert blob["events_inserted"] == 3

    # Cross-check rows in the DB.
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM events")
        row = cur.fetchone()
        assert row is not None
        n = row["count"] if isinstance(row, dict) else row[0]
        assert int(n) == 3

    # H-1 fix (review H): cold-start path must pin live event_loop cursor.
    # Without this fix, the cursor stays at HOOK_DEPLOY_BLOCK default and the
    # first event_loop.tick() re-scans the entire history.
    assert state.get_int_key("last_scanned_block", 0) == head + 1


def test_backfill_rpc_error_with_retry(monkeypatch: pytest.MonkeyPatch, _force_hooks: None) -> None:
    """Transient RPC failures: backoff retries, succeeds on attempt 3."""

    head = HOOK_DEPLOY_BLOCK + 50
    _install_fake_w3(monkeypatch, head=head + 5)
    _patch_cfg(monkeypatch, chunk_blocks_default=1000)

    calls = {"n": 0}

    def flaky_scan(
        _w3: Any,
        _hooks: list[str],
        from_block: int,
        _to_block: int,
        *,
        chunk_size: int = 0,
    ) -> list[dict[str, Any]]:
        calls["n"] += 1
        if calls["n"] < 3:
            raise RuntimeError("transient RPC blip")
        return [_make_event(from_block, 0)]

    monkeypatch.setattr(backfill.shared_events, "scan_logs", flaky_scan)

    backfill.run_if_needed()

    assert calls["n"] == 3, "should retry twice then succeed"
    blob = state.get_json_key("backfill_status")
    assert blob is not None
    assert blob["complete"] is True
    assert blob["events_inserted"] == 1


def test_backfill_rpc_error_persistent_abort(
    monkeypatch: pytest.MonkeyPatch, _force_hooks: None
) -> None:
    """All retries fail → graceful exit, status left as in-progress."""

    head = HOOK_DEPLOY_BLOCK + 50
    _install_fake_w3(monkeypatch, head=head + 5)
    _patch_cfg(monkeypatch, chunk_blocks_default=1000)

    def always_fail(*_a: Any, **_kw: Any) -> list[dict[str, Any]]:
        raise RuntimeError("rpc down permanently")

    monkeypatch.setattr(backfill.shared_events, "scan_logs", always_fail)

    backfill.run_if_needed()  # MUST NOT RAISE

    blob = state.get_json_key("backfill_status")
    assert blob is not None
    assert blob["complete"] is False
    assert "progressBlock" in blob
    # No chunk completed → progressBlock = chunk_start - 1 = from_block - 1.
    assert blob["progressBlock"] == HOOK_DEPLOY_BLOCK - 1
    assert blob["events_inserted"] == 0


def test_backfill_chunk_too_large_fallback(
    monkeypatch: pytest.MonkeyPatch, _force_hooks: None
) -> None:
    """RPC "range too large" → switch to CHUNK_BLOCKS_FALLBACK and succeed.

    C-2 regression (review H): the old assertion only checked that at least
    one event was inserted, which let the C-1 silent-skip slip through (the
    fallback would shrink chunk_end locally but the outer loop kept advancing
    by the *old* wide chunk_end, leaving holes). The new assertions verify
    continuous coverage — every block in [HOOK_DEPLOY_BLOCK, head] is touched
    by exactly one scan window.
    """

    head = HOOK_DEPLOY_BLOCK + 200
    _install_fake_w3(monkeypatch, head=head + 5)
    _patch_cfg(monkeypatch, chunk_blocks_default=5000, chunk_blocks_fallback=100)

    seen_chunk_sizes: list[int] = []
    scanned_ranges: list[tuple[int, int]] = []

    def picky_scan(
        _w3: Any,
        _hooks: list[str],
        from_block: int,
        to_block: int,
        *,
        chunk_size: int = 0,
    ) -> list[dict[str, Any]]:
        seen_chunk_sizes.append(chunk_size)
        if chunk_size > 100:
            raise RuntimeError("eth_getLogs: range too large")
        # Record the successful range so we can verify continuous coverage.
        scanned_ranges.append((from_block, to_block))
        return [_make_event(from_block, 0)]

    monkeypatch.setattr(backfill.shared_events, "scan_logs", picky_scan)

    backfill.run_if_needed()

    # First call with big chunk fails, switches to fallback (100), then succeeds.
    assert seen_chunk_sizes[0] == 5000
    assert 100 in seen_chunk_sizes
    blob = state.get_json_key("backfill_status")
    assert blob is not None
    assert blob["complete"] is True
    assert blob["events_inserted"] >= 1

    # C-2: assert continuous coverage. Sort by start, then verify each chunk
    # picks up where the previous left off and that the union covers
    # [HOOK_DEPLOY_BLOCK, head] exactly.
    scanned_ranges.sort()
    assert scanned_ranges, "no successful scans recorded"
    assert (
        scanned_ranges[0][0] == HOOK_DEPLOY_BLOCK
    ), f"coverage must start at HOOK_DEPLOY_BLOCK, got {scanned_ranges[0][0]}"
    assert (
        scanned_ranges[-1][1] == head
    ), f"coverage must end at head ({head}), got {scanned_ranges[-1][1]}"
    for (_, prev_end), (next_start, _) in pairwise(scanned_ranges):
        assert (
            next_start == prev_end + 1
        ), f"gap in coverage: [{prev_end + 1}..{next_start - 1}] unscanned"
