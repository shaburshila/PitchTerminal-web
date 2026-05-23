"""Seed the ``tokens`` table from ``backend/data/tokens.json``.

Source: portable PitchTerminal ``tokens.json`` (48 countries + 144 players).

Format (portable):

.. code-block:: json

    {
      "countries": [
        {"id": 0, "symbol": "USA", "name": "USA", "address": "0x..."},
        ...
      ],
      "players": [
        {"symbol": "PULISIC", "name": "Christian Pulisic",
         "address": "0x...", "country": "USA", "role": "best"},
        ...
      ]
    }

Note: ``player.country`` is the country **symbol** (e.g. ``"USA"``), not an
address. The seeder resolves it via the countries' ``symbol -> address`` map.

Loading strategy:

* Single transaction.
* Countries inserted first, then players. The FK ``tokens_country_fk`` is
  declared ``DEFERRABLE INITIALLY DEFERRED`` in ``db-schema.sql``, so order
  isn't strictly required, but inserting in the natural order keeps the SQL
  log readable and avoids relying on the DEFERRED behaviour.
* Addresses normalized to lowercase (CHECK constraint requires
  ``^0x[0-9a-f]{40}$``).
* Duplicate addresses inside the JSON are rejected up-front (data quality
  guard — silently skipping them via ``ON CONFLICT`` would hide bugs in the
  source data).
* Idempotent across runs via ``ON CONFLICT (address) DO NOTHING``.

CLI::

    python -m scripts.seed_tokens [--dry-run] [--json PATH]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
from dotenv import load_dotenv

# Allow `python backend/scripts/seed_tokens.py` AND `python -m scripts.seed_tokens`
# from inside `backend/` by injecting the backend root into sys.path.
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

# Standalone seed: we don't want to pull in `shared.config` (which mandates a
# full env set: JWT_SECRET, RPC_URL, ...). DB URL is all we need.
load_dotenv(_BACKEND_ROOT / ".env")
load_dotenv()  # also pick up an env file in cwd, if any


DEFAULT_JSON_PATH = _BACKEND_ROOT / "data" / "tokens.json"

_VALID_ROLES = {"best", "captain", "rookie"}


@dataclass(frozen=True)
class SeedCounts:
    """Result of a seed run.

    On ``--dry-run``, ``inserted_*`` carry "would-insert" counts (all rows from
    the validated JSON) and ``skipped_*`` are zero — there's no DB to compare
    against. The ``dry_run`` flag distinguishes the two cases.
    """

    inserted_countries: int
    skipped_countries: int
    inserted_players: int
    skipped_players: int
    dry_run: bool = False

    def as_log_line(self) -> str:
        prefix = "[dry-run] would_insert" if self.dry_run else "inserted"
        return (
            f"{prefix}_countries={self.inserted_countries} "
            f"skipped_countries={self.skipped_countries} "
            f"{prefix}_players={self.inserted_players} "
            f"skipped_players={self.skipped_players}"
        )


def load_tokens_json(path: Path) -> dict[str, Any]:
    """Read & parse ``tokens.json`` from ``path``."""

    with path.open("r", encoding="utf-8") as fh:
        data: dict[str, Any] = json.load(fh)
    if "countries" not in data or "players" not in data:
        raise ValueError(
            f"tokens.json missing required keys 'countries'/'players' (got {list(data)})"
        )
    return data


def _normalize_address(addr: str) -> str:
    """Lowercase and validate basic shape. CHECK constraint will re-validate."""

    s = addr.strip().lower()
    if not (s.startswith("0x") and len(s) == 42):
        raise ValueError(f"invalid address shape: {addr!r}")
    return s


def _build_country_symbol_to_address(countries: list[dict[str, Any]]) -> dict[str, str]:
    """Map country.symbol -> lowercased address."""

    out: dict[str, str] = {}
    for c in countries:
        sym = c["symbol"]
        addr = _normalize_address(c["address"])
        if sym in out:
            raise ValueError(f"duplicate country symbol {sym!r}")
        out[sym] = addr
    return out


def seed_from_data(
    data: dict[str, Any],
    conn: psycopg.Connection[Any] | None = None,
    *,
    dry_run: bool = False,
) -> SeedCounts:
    """Run the seed using an already-parsed JSON dict.

    Either pass an open ``psycopg.Connection`` (we use the same transaction) or
    leave ``conn=None`` to fetch one from the shared pool. On dry-run we still
    validate but never execute INSERTs.
    """

    countries = data["countries"]
    players = data["players"]

    symbol_to_addr = _build_country_symbol_to_address(countries)

    # Pre-validate every player BEFORE touching the DB. Also reject duplicate
    # player.address inside the JSON itself — silently skipping them via
    # ON CONFLICT would mask data-quality bugs in the source feed.
    seen_player_addrs: set[str] = set()
    prepared_players: list[tuple[str, str, str, str, str]] = []
    for p in players:
        country_sym = p["country"]
        if country_sym not in symbol_to_addr:
            raise ValueError(
                f"player {p.get('symbol')!r}: unknown country symbol {country_sym!r}"
            )
        role = p["role"]
        if role not in _VALID_ROLES:
            raise ValueError(f"player {p.get('symbol')!r}: invalid role {role!r}")
        addr = _normalize_address(p["address"])
        if addr in seen_player_addrs:
            raise ValueError(
                f"player {p.get('symbol')!r}: duplicate address {addr!r} "
                "(already used by another player in tokens.json)"
            )
        seen_player_addrs.add(addr)
        prepared_players.append(
            (
                addr,
                str(p["name"]),
                str(p["symbol"]),
                symbol_to_addr[country_sym],
                role,
            )
        )

    prepared_countries: list[tuple[str, str, str]] = [
        (_normalize_address(c["address"]), str(c["name"]), str(c["symbol"]))
        for c in countries
    ]

    if dry_run:
        # Validation succeeded — report what would be inserted on a real run.
        # Skipped counts are 0 because we never touched the DB.
        return SeedCounts(
            inserted_countries=len(prepared_countries),
            skipped_countries=0,
            inserted_players=len(prepared_players),
            skipped_players=0,
            dry_run=True,
        )

    if conn is None:
        with _connect_default() as owned_conn:
            return _do_insert(owned_conn, prepared_countries, prepared_players)
    return _do_insert(conn, prepared_countries, prepared_players)


@contextmanager
def _connect_default() -> Any:
    """Open a fresh ``psycopg.Connection`` using ``$DATABASE_URL``."""

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL not set — put it in backend/.env or export it"
        )
    # Normalize `postgresql+psycopg://` (SQLAlchemy-style) to plain
    # `postgresql://` for raw psycopg.
    if url.startswith("postgresql+psycopg://"):
        url = "postgresql://" + url[len("postgresql+psycopg://") :]
    conn = psycopg.connect(url)
    try:
        yield conn
    finally:
        conn.close()


def _do_insert(
    conn: psycopg.Connection[Any],
    countries: list[tuple[str, str, str]],
    players: list[tuple[str, str, str, str, str]],
) -> SeedCounts:
    inserted_c = 0
    skipped_c = 0
    inserted_p = 0
    skipped_p = 0

    # FK is DEFERRABLE INITIALLY DEFERRED per db-schema.sql, so no explicit
    # SET CONSTRAINTS is needed — we insert countries first anyway. Adding an
    # explicit deferral would hard-code the constraint name and create a
    # maintenance trap if the schema ever renames it.
    with conn.cursor() as cur:
        for addr, name, symbol in countries:
            cur.execute(
                """
                INSERT INTO tokens (address, name, symbol, kind, country_address, role)
                VALUES (%s, %s, %s, 'country', NULL, NULL)
                ON CONFLICT (address) DO NOTHING
                """,
                (addr, name, symbol),
            )
            if cur.rowcount == 1:
                inserted_c += 1
            else:
                skipped_c += 1

        for addr, name, symbol, country_addr, role in players:
            cur.execute(
                """
                INSERT INTO tokens (address, name, symbol, kind, country_address, role)
                VALUES (%s, %s, %s, 'player', %s, %s::player_role)
                ON CONFLICT (address) DO NOTHING
                """,
                (addr, name, symbol, country_addr, role),
            )
            if cur.rowcount == 1:
                inserted_p += 1
            else:
                skipped_p += 1

    conn.commit()
    return SeedCounts(
        inserted_countries=inserted_c,
        skipped_countries=skipped_c,
        inserted_players=inserted_p,
        skipped_players=skipped_p,
    )


def seed(json_path: Path = DEFAULT_JSON_PATH, *, dry_run: bool = False) -> SeedCounts:
    """High-level entry point: load JSON from disk and seed."""

    data = load_tokens_json(json_path)
    return seed_from_data(data, dry_run=dry_run)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed tokens table from tokens.json")
    parser.add_argument(
        "--json",
        type=Path,
        default=DEFAULT_JSON_PATH,
        help=f"Path to tokens.json (default: {DEFAULT_JSON_PATH})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate JSON without writing to the DB.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    counts = seed(args.json, dry_run=args.dry_run)
    print(counts.as_log_line())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
