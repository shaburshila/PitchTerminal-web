"""Integration tests for :mod:`worker.state` against a real Postgres.

Uses the same DB the rest of the integration suite hits (see
``tests/integration/conftest.py``). Each test clears the relevant ``app_state``
keys up-front.
"""

from __future__ import annotations

import os

import psycopg
import pytest

from worker import state


@pytest.fixture(autouse=True)
def _clear_app_state() -> None:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("DELETE FROM app_state WHERE key LIKE 'test_%'")
        conn.commit()


def test_set_and_get_int_key() -> None:
    state.set_int_key("test_int_key", 42)
    assert state.get_int_key("test_int_key", -1) == 42


def test_get_int_key_default_when_absent() -> None:
    assert state.get_int_key("test_absent_int", 7) == 7


def test_set_int_key_overwrites() -> None:
    state.set_int_key("test_overwrite", 1)
    state.set_int_key("test_overwrite", 99)
    assert state.get_int_key("test_overwrite", -1) == 99


def test_set_and_get_json_key() -> None:
    payload = {"a": 1, "b": "two", "c": [3, 4, 5]}
    state.set_json_key("test_json_key", payload)
    got = state.get_json_key("test_json_key")
    assert got == payload


def test_get_json_key_absent_returns_none() -> None:
    assert state.get_json_key("test_absent_json") is None


def test_int_key_storage_shape_is_block_object() -> None:
    """Sanity: int keys are stored as ``{"block": N}`` (canonical shape)."""

    state.set_int_key("test_shape_check", 12345)
    blob = state.get_json_key("test_shape_check")
    assert blob == {"block": 12345}
