"""Integration tests for :mod:`worker.dex_pitch_loop` against real Postgres.

Mirrors ``test_worker_backfill_stub.py``: we monkey-patch ``worker._w3.get_w3``
with a fake ``w3`` whose ``eth.get_logs`` returns synthetic ERC20 Transfer logs,
run a tick, and assert rows land in ``dex_pitch_trades`` and the cursor advances.

We verify:
* scan → classify → upsert → cursor advance (external buy w/ WETH leg).
* idempotent re-scan (ON CONFLICT DO NOTHING — no dup rows, cursor stays put).
* native-ETH buy: getTransaction is consulted only for the no-quote candidate.
* cursor independence from the hook scanner's ``last_scanned_block``.
* no-op when from_block > head.
"""

from __future__ import annotations

import dataclasses
import os
from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row
from web3 import Web3

from shared.config import PITCH_TOKEN_ADDR, WETH_ADDR
from worker import _w3, dex_pitch_loop, state

PITCH = PITCH_TOKEN_ADDR.lower()
WETH = WETH_ADDR.lower()
TRADER = "0x71ecd1a09380ca46cca741bc48d04c556674756f"
POOL = "0xec44849198fbf8b6dc239df418ea7be017240368"

_TRANSFER_TOPIC = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex()
_FROM = 46_167_000


def _patch_cfg(monkeypatch: pytest.MonkeyPatch, **overrides: Any) -> None:
    monkeypatch.setattr(
        dex_pitch_loop, "config", dataclasses.replace(dex_pitch_loop.config, **overrides)
    )


def _addr_topic(addr: str) -> str:
    return "0x" + addr.lower().removeprefix("0x").rjust(64, "0")


def _transfer_log(
    *,
    token: str,
    frm: str,
    to: str,
    value: int,
    block: int,
    log_index: int,
    tx: str,
) -> dict[str, Any]:
    return {
        "address": token,
        "topics": [_TRANSFER_TOPIC, _addr_topic(frm), _addr_topic(to)],
        "data": "0x" + value.to_bytes(32, "big").hex(),
        "blockNumber": block,
        "transactionHash": tx,
        "logIndex": log_index,
    }


@pytest.fixture(autouse=True)
def _reset_state() -> Iterator[None]:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM app_state WHERE key IN (%s, 'last_scanned_block')",
            (dex_pitch_loop.CURSOR_KEY,),
        )
        cur.execute("DELETE FROM dex_pitch_trades")
        conn.commit()
    _w3.reset()
    yield
    _w3.reset()


class _FakeBlock:
    def __init__(self, ts: int) -> None:
        self.timestamp = ts


class _FakeEth:
    def __init__(
        self,
        head: int,
        logs: list[dict[str, Any]],
        txs: dict[str, int],
        froms: dict[str, str],
    ) -> None:
        self.block_number = head
        self._logs = logs
        self._txs = txs
        self._froms = froms
        self.get_logs_calls: list[dict[str, Any]] = []
        self.get_tx_calls: list[str] = []
        self.get_receipt_calls: list[str] = []

    def get_logs(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        self.get_logs_calls.append(params)
        start = int(params["fromBlock"])
        end = int(params["toBlock"])
        # Honour the ``address`` filter — the loop scans PITCH ONLY (it must not
        # pull WETH/USDC, whose volume is unbounded on Base).
        addrs = params.get("address")
        if isinstance(addrs, str):
            addr_set: set[str] | None = {addrs.lower()}
        elif addrs:
            addr_set = {a.lower() for a in addrs}
        else:
            addr_set = None
        return [
            lg
            for lg in self._logs
            if start <= int(lg["blockNumber"]) <= end
            and (addr_set is None or str(lg["address"]).lower() in addr_set)
        ]

    def get_block(self, n: int) -> _FakeBlock:
        return _FakeBlock(1_700_000_000 + int(n))

    def get_transaction(self, tx_hash: str) -> dict[str, Any]:
        self.get_tx_calls.append(tx_hash)
        return {"value": self._txs.get(tx_hash, 0), "from": self._froms.get(tx_hash, TRADER)}

    def get_transaction_receipt(self, tx_hash: str) -> dict[str, Any]:
        # The loop reads the full PITCH/WETH/USDC counter-legs from the receipt
        # of each candidate (PITCH-touching) tx. The receipt also carries the
        # sender (trader EOA).
        self.get_receipt_calls.append(tx_hash)
        return {
            "from": self._froms.get(tx_hash, TRADER),
            "logs": [lg for lg in self._logs if lg["transactionHash"] == tx_hash],
        }


class _FakeW3:
    def __init__(
        self,
        head: int,
        logs: list[dict[str, Any]],
        txs: dict[str, int],
        froms: dict[str, str],
    ) -> None:
        self.eth = _FakeEth(head, logs, txs, froms)


def _install(
    monkeypatch: pytest.MonkeyPatch,
    head: int,
    logs: list[dict[str, Any]],
    txs: dict[str, int] | None = None,
    froms: dict[str, str] | None = None,
) -> _FakeW3:
    fake = _FakeW3(head, logs, txs or {}, froms or {})
    monkeypatch.setattr(_w3, "get_w3", lambda: fake)
    return fake


def _count_rows() -> int:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM dex_pitch_trades")
        row = cur.fetchone()
        assert row is not None
        return int(row["c"] if isinstance(row, dict) else row[0])


# ── tests ────────────────────────────────────────────────────────────────────


def test_tick_inserts_external_buy_and_advances_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0, chunk_blocks_default=5000)
    block = _FROM + 100
    tx = "0x" + "11" * 32
    logs = [
        _transfer_log(token=WETH, frm=TRADER, to=POOL, value=5 * 10**17, block=block, log_index=0, tx=tx),
        _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=100 * 10**18, block=block, log_index=1, tx=tx),
    ]
    head = block + 3
    fake = _install(monkeypatch, head, logs)

    dex_pitch_loop.tick()

    assert _count_rows() == 1
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn, conn.cursor() as cur:
        cur.execute("SELECT direction, pitch_amount, quote_token, quote_amount FROM dex_pitch_trades")
        r = cur.fetchone()
        assert r is not None
        assert r["direction"] == "buy"
        assert int(r["pitch_amount"]) == 100 * 10**18
        assert r["quote_token"].strip() == WETH
        assert int(r["quote_amount"]) == 5 * 10**17

    assert state.get_int_key(dex_pitch_loop.CURSOR_KEY, -1) == head

    # CRITICAL invariant: the scan must request PITCH ONLY — never WETH/USDC,
    # whose Base transfer volume would blow past eth_getLogs result limits.
    # The WETH counter-leg comes from the receipt, not from a WETH log scan.
    scanned_addrs = {
        a.lower()
        for call in fake.eth.get_logs_calls
        for a in ([call["address"]] if isinstance(call["address"], str) else call["address"])
    }
    assert scanned_addrs == {PITCH}, f"scan must be PITCH-only, got {scanned_addrs}"
    assert fake.eth.get_receipt_calls, "WETH/USDC legs must come from tx receipts"


def test_tick_idempotent_rescan(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    block = _FROM + 10
    tx = "0x" + "22" * 32
    logs = [
        _transfer_log(token=WETH, frm=TRADER, to=POOL, value=1 * 10**17, block=block, log_index=0, tx=tx),
        _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=9 * 10**18, block=block, log_index=1, tx=tx),
    ]
    head = block + 1
    _install(monkeypatch, head, logs)

    dex_pitch_loop.tick()
    assert _count_rows() == 1

    # Re-point cursor back and re-run the same range: ON CONFLICT → still 1 row.
    state.set_int_key(dex_pitch_loop.CURSOR_KEY, _FROM)
    _install(monkeypatch, head, logs)
    dex_pitch_loop.tick()
    assert _count_rows() == 1


def test_tick_native_eth_buy_consults_get_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    block = _FROM + 20
    tx = "0x" + "33" * 32
    # PITCH-in only, no WETH/USDC leg → native-ETH candidate.
    logs = [
        _transfer_log(token=PITCH, frm=POOL, to=TRADER, value=50 * 10**18, block=block, log_index=0, tx=tx),
    ]
    head = block + 1
    fake = _install(monkeypatch, head, logs, txs={tx: 3 * 10**17})

    dex_pitch_loop.tick()

    assert fake.eth.get_tx_calls == [tx], "getTransaction must be called for the candidate tx"
    assert _count_rows() == 1
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn, conn.cursor() as cur:
        cur.execute("SELECT quote_token, quote_amount FROM dex_pitch_trades")
        r = cur.fetchone()
        assert r is not None
        assert r["quote_token"].strip() == WETH
        assert int(r["quote_amount"]) == 3 * 10**17


def test_cursor_independent_from_hook_scanner(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    state.set_int_key("last_scanned_block", _FROM + 999_999)  # hook cursor far ahead
    head = _FROM + 5
    _install(monkeypatch, head, [])

    dex_pitch_loop.tick()

    # Our cursor advanced to head; the hook cursor is untouched.
    assert state.get_int_key(dex_pitch_loop.CURSOR_KEY, -1) == head
    assert state.get_int_key("last_scanned_block", -1) == _FROM + 999_999


def test_tick_caps_blocks_per_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    # Cold-start safety: a tick must NOT scan the whole history in one go (it
    # fetches a receipt per PITCH tx — that would block the keeper). The cursor
    # advances by at most _MAX_BLOCKS_PER_TICK, not straight to head.
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    monkeypatch.setattr(dex_pitch_loop, "_MAX_BLOCKS_PER_TICK", 1000)
    head = _FROM + 50_000  # far beyond the per-tick cap
    fake = _install(monkeypatch, head, [])

    dex_pitch_loop.tick()

    # from_block = _FROM + 1, capped window end = from_block + 1000 - 1.
    assert state.get_int_key(dex_pitch_loop.CURSOR_KEY, -1) == _FROM + 1000
    # get_logs was called only over the capped window, not [_FROM+1, head].
    assert fake.eth.get_logs_calls, "expected a bounded scan"
    assert max(int(c["toBlock"]) for c in fake.eth.get_logs_calls) == _FROM + 1000


def test_tick_noop_when_from_block_above_head(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    state.set_int_key(dex_pitch_loop.CURSOR_KEY, _FROM + 100)
    head = _FROM + 50  # below cursor
    fake = _install(monkeypatch, head, [])

    dex_pitch_loop.tick()

    assert fake.eth.get_logs_calls == [], "no get_logs when nothing to scan"
    assert _count_rows() == 0
