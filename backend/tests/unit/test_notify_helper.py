"""Unit tests for :mod:`shared.notify`.

We patch ``shared.notify.get_conn`` and assert the SQL we'd execute, so the
tests can run without a live Postgres.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any
from unittest.mock import MagicMock

import pytest

from shared import notify as notify_mod


class _FakeCursor:
    def __init__(self) -> None:
        self.execute_calls: list[tuple[str, tuple[Any, ...]]] = []

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> None:
        self.execute_calls.append((sql, params))

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *args: Any) -> None:
        pass


class _FakeConn:
    def __init__(self) -> None:
        self.cursor_obj = _FakeCursor()
        self.committed = False

    def cursor(self) -> _FakeCursor:
        return self.cursor_obj

    def commit(self) -> None:
        self.committed = True


def test_notify_calls_pg_notify(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = _FakeConn()

    @contextmanager
    def fake_get_conn() -> Any:
        yield fake

    monkeypatch.setattr(notify_mod, "get_conn", fake_get_conn)

    notify_mod.notify("pt_prices", '["0xabc"]')

    # After review I M2 the explicit commit was removed — the pool CM commits
    # on clean exit. The remaining contract is: the SELECT pg_notify call
    # reached the cursor with parameterized args.
    assert len(fake.cursor_obj.execute_calls) == 1
    sql, params = fake.cursor_obj.execute_calls[0]
    assert "pg_notify" in sql
    assert params == ("pt_prices", '["0xabc"]')


def test_notify_swallows_db_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> Any:
        raise RuntimeError("db down")

    monkeypatch.setattr(notify_mod, "get_conn", boom)

    # Should not raise — failures are logged.
    notify_mod.notify("pt_prices", "[]")


def test_notify_warns_on_oversized_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = _FakeConn()

    @contextmanager
    def fake_get_conn() -> Any:
        yield fake

    monkeypatch.setattr(notify_mod, "get_conn", fake_get_conn)

    huge = "x" * (notify_mod.NOTIFY_PAYLOAD_MAX_BYTES + 100)
    # Doesn't raise — just logs a warning and tries the send anyway.
    notify_mod.notify("pt_prices", huge)


class TestListenerValidation:
    def test_rejects_empty_channels(self) -> None:
        with pytest.raises(ValueError, match="at least one channel"):
            notify_mod.Listener([])

    def test_rejects_bad_channel_name(self) -> None:
        with pytest.raises(ValueError, match="invalid channel"):
            notify_mod.Listener(["bad name with space"])

        with pytest.raises(ValueError, match="invalid channel"):
            notify_mod.Listener(["pt_prices; DROP TABLE users"])

    def test_accepts_alnum_with_underscores(self) -> None:
        # No connection actually opened — we don't enter the context.
        listener = notify_mod.Listener(["pt_prices", "pt_events_v2"])
        assert listener._channels == ["pt_prices", "pt_events_v2"]


class TestListenerLifecycle:
    def test_listen_without_enter_raises(self) -> None:
        listener = notify_mod.Listener(["pt_prices"])
        with pytest.raises(RuntimeError, match="not entered"):
            list(listener.listen(timeout=0.1))

    def test_context_manager_opens_and_closes(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mock_conn = MagicMock()
        mock_conn.notifies.return_value = iter([])

        def fake_connect(*args: Any, **kwargs: Any) -> Any:
            return mock_conn

        monkeypatch.setattr(notify_mod.psycopg, "connect", fake_connect)

        with notify_mod.Listener(["pt_prices", "pt_events"]) as listener:
            assert listener._conn is mock_conn
            # LISTEN was issued once per channel.
            listen_calls = [
                c
                for c in mock_conn.execute.call_args_list
                if "LISTEN" in c.args[0] and "UNLISTEN" not in c.args[0]
            ]
            assert len(listen_calls) == 2

        # UNLISTEN + close on exit.
        assert mock_conn.close.called
