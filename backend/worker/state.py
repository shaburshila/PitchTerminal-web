"""Helpers around the ``app_state`` key-value table.

All worker loops persist their cursors and snapshots in ``app_state``:
``last_scanned_block``, ``access_last_scanned_block``, ``backfill_status``,
``access_config``. See ``docs/db-schema.sql`` lines 124-147.

Values are JSONB. For ints we wrap them in ``{"block": <int>}`` to keep the
storage schema uniform (JSONB never raw scalars — the column type is JSONB
and a bare integer would be valid JSON but conflicts with the documented
``{"block": ...}`` shape for the migration / port spec).
"""

from __future__ import annotations

import json
from typing import Any

from shared.db import get_conn


def get_json_key(key: str) -> dict[str, Any] | None:
    """Read a JSONB value from ``app_state``. Returns ``None`` if absent."""

    with get_conn() as conn, conn.cursor() as cur:
        cur.execute("SELECT value FROM app_state WHERE key = %s", (key,))
        row = cur.fetchone()
        if row is None:
            return None
        # dict_row factory → row is a dict; raw psycopg JSONB decodes to dict already.
        value = row["value"] if isinstance(row, dict) else row[0]
        if isinstance(value, str):
            # Defensive: some drivers return raw text — decode.
            value = json.loads(value)
        return dict(value) if value is not None else None


def set_json_key(key: str, value: dict[str, Any]) -> None:
    """UPSERT a JSONB value into ``app_state``."""

    payload = json.dumps(value)
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO app_state (key, value) VALUES (%s, %s::jsonb)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
            """,
            (key, payload),
        )
        conn.commit()


def get_int_key(key: str, default: int) -> int:
    """Read ``{"block": <int>}`` from ``app_state[key]`` (or default)."""

    blob = get_json_key(key)
    if blob is None:
        return default
    # Accept either {"block": N} or {"value": N} — first is canonical per
    # db-schema.sql for ``last_scanned_block``.
    if "block" in blob:
        return int(blob["block"])
    if "value" in blob:
        return int(blob["value"])
    raise ValueError(f"app_state[{key!r}]: expected key 'block' or 'value', got {list(blob)}")


def set_int_key(key: str, value: int) -> None:
    """Write ``{"block": <value>}`` to ``app_state[key]``."""

    set_json_key(key, {"block": int(value)})


__all__ = [
    "get_int_key",
    "get_json_key",
    "set_int_key",
    "set_json_key",
]
