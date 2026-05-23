"""Test-wide setup.

``shared.config`` reads env vars at module import time and raises if required
ones are missing. We ensure a minimal valid set is present *before* anything
under ``shared/`` is imported by the test runner.

This file is auto-loaded by pytest from ``backend/tests/`` thanks to the
``testpaths = ["tests"]`` setting in pyproject.
"""

from __future__ import annotations

import os

# Set BEFORE any `import shared.*` happens elsewhere in the suite.
os.environ.setdefault("DATABASE_URL", "postgresql://test:test@localhost:5432/test")
os.environ.setdefault("JWT_SECRET", "test-secret-do-not-use-in-prod-32bytes!")
os.environ.setdefault("RPC_URL", "https://mainnet.base.org")
os.environ.setdefault("RPC_URL_FALLBACK", "https://base.publicnode.com")
os.environ.setdefault("LOG_LEVEL", "DEBUG")
