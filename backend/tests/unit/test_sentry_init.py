"""Unit test: shared.sentry.init() returns False when SENTRY_DSN is unset."""

from __future__ import annotations

import shared.sentry as sentry_module


def test_init_returns_false_without_dsn(monkeypatch):
    # Reset module-level guard so test isolates init state.
    monkeypatch.setattr(sentry_module, "_INITIALIZED", False)
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    assert sentry_module.init("api") is False


def test_init_returns_false_for_empty_dsn(monkeypatch):
    monkeypatch.setattr(sentry_module, "_INITIALIZED", False)
    monkeypatch.setenv("SENTRY_DSN", "   ")  # whitespace-only
    assert sentry_module.init("worker") is False
