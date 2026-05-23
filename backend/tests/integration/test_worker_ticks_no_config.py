"""Integration sanity: each tick is safe to call with no contract envs set.

In Phase 0 the access / hook contract addresses may be empty until the
deploy step (C0.5) lands. The tick loops MUST handle this gracefully —
log + return — rather than raising.
"""

from __future__ import annotations

from worker import access_event_loop, event_loop, price_loop


def test_price_loop_tick_safe_without_hooks() -> None:
    # Should be a no-op (returns silently) when hook addresses are empty.
    # Does NOT raise even if RPC also unreachable in CI.
    price_loop.tick()


def test_event_loop_tick_safe_without_hooks() -> None:
    event_loop.tick()


def test_access_event_loop_tick_safe_without_access_contract() -> None:
    access_event_loop.tick()
