"""Integration tests for :mod:`worker.dex_pitch_loop` against real Postgres.

Candidate-tx discovery scans **Swap events in the external PITCH pools** (NOT
all PITCH ERC20 Transfers — that hit the 89k-transfer deploy airdrop and starved
the worker, incident 2026-05-31). So the fake ``w3.eth.get_logs`` here serves
synthetic Swap logs filtered by:

* the Uniswap V3 PITCH/WETH pool address + ``V3_SWAP_TOPIC``, and
* the Uniswap V4 PoolManager address + ``[V4_SWAP_TOPIC, V4_EXTERNAL_POOL_ID]``
  (the indexed poolId in topic1 filters server-side to the external pool only).

Each Swap log's tx hash maps to a receipt (``get_transaction_receipt``) carrying
the PITCH/WETH/USDC ``Transfer`` legs, which the receipt-based classifier sums.

We verify:
* scan (V3) → classify → upsert → cursor advance (external buy w/ WETH leg).
* V4 PoolManager-by-poolId discovery (V4 acd168 swap → buy).
* multi-hop tx discovered once and summed to the full PITCH delivery.
* idempotent re-scan (ON CONFLICT DO NOTHING — no dup rows).
* native-ETH buy: getTransaction consulted only for the no-quote candidate.
* the scan NEVER scans PITCH ERC20 Transfers (no airdrop noise).
* cursor independence from the hook scanner's ``last_scanned_block``.
* per-chunk checkpoint + wall-clock time budget.
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

from shared.config import (
    DEX_V3_POOL,
    DEX_V4_POOL_MANAGER,
    PITCH_TOKEN_ADDR,
    USDC_ADDR,
    V3_SWAP_TOPIC,
    V4_EXTERNAL_POOL_ID,
    V4_SWAP_TOPIC,
    WETH_ADDR,
)
from worker import _w3, dex_pitch_loop, state

PITCH = PITCH_TOKEN_ADDR.lower()
WETH = WETH_ADDR.lower()
USDC = USDC_ADDR.lower()
V3_POOL = DEX_V3_POOL.lower()
V4_MANAGER = DEX_V4_POOL_MANAGER.lower()
TRADER = "0x71ecd1a09380ca46cca741bc48d04c556674756f"

_TRANSFER_TOPIC = "0x" + Web3.keccak(text="Transfer(address,address,uint256)").hex()
_FROM = 46_126_828


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
    """A synthetic ERC20 Transfer log (lives in a tx receipt, not the scan)."""

    return {
        "address": token,
        "topics": [_TRANSFER_TOPIC, _addr_topic(frm), _addr_topic(to)],
        "data": "0x" + value.to_bytes(32, "big").hex(),
        "blockNumber": block,
        "transactionHash": tx,
        "logIndex": log_index,
    }


def _v3_swap_log(*, block: int, tx: str, log_index: int = 0) -> dict[str, Any]:
    """A synthetic Uniswap V3 Swap log in the PITCH/WETH pool (scan candidate)."""

    return {
        "address": V3_POOL,
        "topics": [V3_SWAP_TOPIC, _addr_topic(TRADER), _addr_topic(TRADER)],
        "data": "0x",
        "blockNumber": block,
        "transactionHash": tx,
        "logIndex": log_index,
    }


def _v4_swap_log(
    *, block: int, tx: str, pool_id: str = V4_EXTERNAL_POOL_ID, log_index: int = 0
) -> dict[str, Any]:
    """A synthetic V4 PoolManager Swap log (poolId in topic1; scan candidate)."""

    return {
        "address": V4_MANAGER,
        "topics": [V4_SWAP_TOPIC, pool_id.lower(), _addr_topic(TRADER)],
        "data": "0x",
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
        swap_logs: list[dict[str, Any]],
        receipt_logs: dict[str, list[dict[str, Any]]],
        txs: dict[str, int],
        froms: dict[str, str],
    ) -> None:
        self.block_number = head
        self._swap_logs = swap_logs
        self._receipt_logs = receipt_logs
        self._txs = txs
        self._froms = froms
        self.get_logs_calls: list[dict[str, Any]] = []
        self.get_tx_calls: list[str] = []
        self.get_receipt_calls: list[str] = []

    def get_logs(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        self.get_logs_calls.append(params)
        start = int(params["fromBlock"])
        end = int(params["toBlock"])
        addr = str(params["address"]).lower()
        topics = params.get("topics") or []
        topic0 = str(topics[0]).lower() if topics else None
        topic1 = str(topics[1]).lower() if len(topics) > 1 else None

        out = []
        for lg in self._swap_logs:
            if not (start <= int(lg["blockNumber"]) <= end):
                continue
            if str(lg["address"]).lower() != addr:
                continue
            lg_topics = [str(t).lower() for t in lg["topics"]]
            if topic0 is not None and lg_topics[0] != topic0:
                continue
            if topic1 is not None and (len(lg_topics) < 2 or lg_topics[1] != topic1):
                continue
            out.append(lg)
        return out

    def get_block(self, n: int) -> _FakeBlock:
        return _FakeBlock(1_700_000_000 + int(n))

    def get_transaction(self, tx_hash: str) -> dict[str, Any]:
        self.get_tx_calls.append(tx_hash)
        return {"value": self._txs.get(tx_hash, 0), "from": self._froms.get(tx_hash, TRADER)}

    def get_transaction_receipt(self, tx_hash: str) -> dict[str, Any]:
        self.get_receipt_calls.append(tx_hash)
        return {
            "from": self._froms.get(tx_hash, TRADER),
            "logs": self._receipt_logs.get(tx_hash, []),
        }


class _FakeW3:
    def __init__(
        self,
        head: int,
        swap_logs: list[dict[str, Any]],
        receipt_logs: dict[str, list[dict[str, Any]]],
        txs: dict[str, int],
        froms: dict[str, str],
    ) -> None:
        self.eth = _FakeEth(head, swap_logs, receipt_logs, txs, froms)


def _install(
    monkeypatch: pytest.MonkeyPatch,
    head: int,
    swap_logs: list[dict[str, Any]],
    receipt_logs: dict[str, list[dict[str, Any]]] | None = None,
    txs: dict[str, int] | None = None,
    froms: dict[str, str] | None = None,
) -> _FakeW3:
    fake = _FakeW3(head, swap_logs, receipt_logs or {}, txs or {}, froms or {})
    monkeypatch.setattr(_w3, "get_w3", lambda: fake)
    return fake


def _count_rows() -> int:
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) AS c FROM dex_pitch_trades")
        row = cur.fetchone()
        assert row is not None
        return int(row["c"] if isinstance(row, dict) else row[0])


# ── tests ────────────────────────────────────────────────────────────────────


def test_tick_inserts_external_buy_via_v3_and_advances_cursor(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_cfg(
        monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0, chunk_blocks_default=5000
    )
    block = _FROM + 100
    tx = "0x" + "11" * 32
    swap_logs = [_v3_swap_log(block=block, tx=tx)]
    receipt_logs = {
        tx: [
            _transfer_log(
                token=WETH,
                frm=TRADER,
                to=V3_POOL,
                value=5 * 10**17,
                block=block,
                log_index=0,
                tx=tx,
            ),
            _transfer_log(
                token=PITCH,
                frm=V3_POOL,
                to=TRADER,
                value=100 * 10**18,
                block=block,
                log_index=1,
                tx=tx,
            ),
        ]
    }
    head = block + 3
    fake = _install(monkeypatch, head, swap_logs, receipt_logs)

    dex_pitch_loop.tick()

    assert _count_rows() == 1
    with (
        psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
        conn.cursor() as cur,
    ):
        cur.execute(
            "SELECT direction, pitch_amount, quote_token, quote_amount FROM dex_pitch_trades"
        )
        r = cur.fetchone()
        assert r is not None
        assert r["direction"] == "buy"
        assert int(r["pitch_amount"]) == 100 * 10**18
        assert r["quote_token"].strip() == WETH
        assert int(r["quote_amount"]) == 5 * 10**17

    assert state.get_int_key(dex_pitch_loop.CURSOR_KEY, -1) == head

    # CRITICAL: discovery scans the external POOLS' Swap events — never the PITCH
    # ERC20 Transfer topic (the 89k-transfer airdrop noise that starved the
    # worker). Assert no scan touched the PITCH token address.
    scanned_addrs = {str(c["address"]).lower() for c in fake.eth.get_logs_calls}
    assert PITCH not in scanned_addrs, f"must NOT scan PITCH transfers, got {scanned_addrs}"
    assert scanned_addrs == {V3_POOL, V4_MANAGER}
    assert fake.eth.get_receipt_calls == [tx], "legs come from the candidate tx's receipt"


def test_tick_v4_poolmanager_by_poolid(monkeypatch: pytest.MonkeyPatch) -> None:
    # The V4 swap is discovered via PoolManager address + external poolId topic1.
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    block = _FROM + 200
    tx = "0x" + "44" * 32
    swap_logs = [_v4_swap_log(block=block, tx=tx)]
    receipt_logs = {
        tx: [
            _transfer_log(
                token=PITCH,
                frm=V4_MANAGER,
                to=TRADER,
                value=102 * 10**18,
                block=block,
                log_index=0,
                tx=tx,
            ),
        ]
    }
    head = block + 1
    fake = _install(monkeypatch, head, swap_logs, receipt_logs, txs={tx: 1 * 10**17})

    dex_pitch_loop.tick()

    assert _count_rows() == 1
    with (
        psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT direction, pitch_amount FROM dex_pitch_trades")
        r = cur.fetchone()
        assert r is not None
        assert r["direction"] == "buy"
        assert int(r["pitch_amount"]) == 102 * 10**18

    # The V4 getLogs must carry the poolId as topic1 (server-side external
    # filter), and discovery still scans both venues.
    v4_calls = [c for c in fake.eth.get_logs_calls if str(c["address"]).lower() == V4_MANAGER]
    assert v4_calls, "expected a V4 PoolManager scan"
    for c in v4_calls:
        topics = c["topics"]
        assert str(topics[0]).lower() == V4_SWAP_TOPIC.lower()
        assert str(topics[1]).lower() == V4_EXTERNAL_POOL_ID.lower()


def test_tick_excludes_inapp_v4_poolid(monkeypatch: pytest.MonkeyPatch) -> None:
    # A V4 swap in the IN-APP country/PITCH pool (different poolId) must NOT be
    # discovered — the poolId topic1 filter excludes it server-side.
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    inapp_pool_id = "0x1660e4dafc17907854cc0f46362b720d3b6090bb60585a5e7a4c040dd4caec1e"
    block = _FROM + 300
    tx = "0x" + "55" * 32
    swap_logs = [_v4_swap_log(block=block, tx=tx, pool_id=inapp_pool_id)]
    receipt_logs = {
        tx: [
            _transfer_log(
                token=PITCH,
                frm=TRADER,
                to=V4_MANAGER,
                value=5 * 10**18,
                block=block,
                log_index=0,
                tx=tx,
            ),
        ]
    }
    head = block + 1
    fake = _install(monkeypatch, head, swap_logs, receipt_logs)

    dex_pitch_loop.tick()

    assert _count_rows() == 0, "in-app pool swaps must be excluded by the poolId filter"
    assert fake.eth.get_receipt_calls == [], "no candidate → no receipt fetch"


def test_tick_multihop_summed_to_full_delivery(monkeypatch: pytest.MonkeyPatch) -> None:
    # Multi-hop aggregator route (the 0x2113baac case): WETH->USDC->PITCH
    # delivers PITCH to the wallet in TWO legs. The tx is discovered once (it
    # touches the external V4 pool) and the receipt legs sum to the full
    # delivery (41.439 + 13.764 = 55.204 PITCH).
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    block = _FROM + 400
    tx = "0x2113baac" + "00" * 28
    leg_a = 41_439 * 10**15
    leg_b = 13_764 * 10**15
    swap_logs = [_v4_swap_log(block=block, tx=tx)]
    receipt_logs = {
        tx: [
            _transfer_log(
                token=WETH,
                frm=TRADER,
                to=V4_MANAGER,
                value=71 * 10**15,
                block=block,
                log_index=0,
                tx=tx,
            ),
            _transfer_log(
                token=USDC,
                frm=V4_MANAGER,
                to=V4_MANAGER,
                value=50_490_000,
                block=block,
                log_index=1,
                tx=tx,
            ),
            _transfer_log(
                token=PITCH, frm=V4_MANAGER, to=TRADER, value=leg_a, block=block, log_index=2, tx=tx
            ),
            _transfer_log(
                token=PITCH, frm=V4_MANAGER, to=TRADER, value=leg_b, block=block, log_index=3, tx=tx
            ),
        ]
    }
    head = block + 1
    _install(monkeypatch, head, swap_logs, receipt_logs)

    dex_pitch_loop.tick()

    assert _count_rows() == 1
    with (
        psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
        conn.cursor() as cur,
    ):
        cur.execute("SELECT direction, pitch_amount FROM dex_pitch_trades")
        r = cur.fetchone()
        assert r is not None
        assert r["direction"] == "buy"
        assert int(r["pitch_amount"]) == leg_a + leg_b == 55_203 * 10**15


def test_tick_idempotent_rescan(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    block = _FROM + 10
    tx = "0x" + "22" * 32
    swap_logs = [_v3_swap_log(block=block, tx=tx)]
    receipt_logs = {
        tx: [
            _transfer_log(
                token=WETH,
                frm=TRADER,
                to=V3_POOL,
                value=1 * 10**17,
                block=block,
                log_index=0,
                tx=tx,
            ),
            _transfer_log(
                token=PITCH,
                frm=V3_POOL,
                to=TRADER,
                value=9 * 10**18,
                block=block,
                log_index=1,
                tx=tx,
            ),
        ]
    }
    head = block + 1
    _install(monkeypatch, head, swap_logs, receipt_logs)

    dex_pitch_loop.tick()
    assert _count_rows() == 1

    # Re-point cursor back and re-run the same range: ON CONFLICT → still 1 row.
    state.set_int_key(dex_pitch_loop.CURSOR_KEY, _FROM)
    _install(monkeypatch, head, swap_logs, receipt_logs)
    dex_pitch_loop.tick()
    assert _count_rows() == 1


def test_tick_native_eth_buy_consults_get_transaction(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    block = _FROM + 20
    tx = "0x" + "33" * 32
    # PITCH-in only, no WETH/USDC leg → native-ETH candidate.
    swap_logs = [_v4_swap_log(block=block, tx=tx)]
    receipt_logs = {
        tx: [
            _transfer_log(
                token=PITCH,
                frm=V4_MANAGER,
                to=TRADER,
                value=50 * 10**18,
                block=block,
                log_index=0,
                tx=tx,
            ),
        ]
    }
    head = block + 1
    fake = _install(monkeypatch, head, swap_logs, receipt_logs, txs={tx: 3 * 10**17})

    dex_pitch_loop.tick()

    assert fake.eth.get_tx_calls == [tx], "getTransaction must be called for the candidate tx"
    assert _count_rows() == 1
    with (
        psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
        conn.cursor() as cur,
    ):
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


def test_tick_per_chunk_checkpoint_and_time_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    # A tight wall-clock budget must STOP starting new chunks, advancing the
    # cursor only to the LAST COMPLETED chunk (per-chunk checkpointing).
    _patch_cfg(
        monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0, chunk_blocks_default=1000
    )
    monkeypatch.setattr(dex_pitch_loop, "DEX_TICK_BUDGET_SEC", 0.0)
    head = _FROM + 50_000  # many chunks
    fake = _install(monkeypatch, head, [])

    dex_pitch_loop.tick()

    # With a 0s budget the loop runs exactly one chunk (the in-flight chunk
    # always finishes), then yields. Cursor = end of the first chunk only.
    assert state.get_int_key(dex_pitch_loop.CURSOR_KEY, -1) == _FROM + 1000
    # Only the first chunk's window was scanned (2 venues = 2 get_logs calls).
    assert max(int(c["toBlock"]) for c in fake.eth.get_logs_calls) == _FROM + 1000


def test_tick_advances_per_chunk_under_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    # With ample budget, all chunks process and the cursor reaches head.
    _patch_cfg(
        monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0, chunk_blocks_default=1000
    )
    head = _FROM + 3500
    _install(monkeypatch, head, [])

    dex_pitch_loop.tick()

    assert state.get_int_key(dex_pitch_loop.CURSOR_KEY, -1) == head


def test_tick_receipt_budget_cut_holds_cursor(monkeypatch: pytest.MonkeyPatch) -> None:
    # Issue-1 safety: even with a candidate swap present, an exhausted budget must
    # cut the receipt loop BEFORE any getTransactionReceipt — so a burst of
    # candidates in one chunk can NEVER block the worker. Cursor is held (the chunk
    # re-scans next tick; writes are idempotent) and nothing is inserted.
    _patch_cfg(
        monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0, chunk_blocks_default=5000
    )
    monkeypatch.setattr(dex_pitch_loop, "DEX_TICK_BUDGET_SEC", 0.0)
    block = _FROM + 100
    tx = "0x" + "aa" * 32
    swap_logs = [_v3_swap_log(block=block, tx=tx)]
    receipt_logs = {
        tx: [
            _transfer_log(
                token=WETH,
                frm=TRADER,
                to=V3_POOL,
                value=5 * 10**17,
                block=block,
                log_index=0,
                tx=tx,
            ),
            _transfer_log(
                token=PITCH,
                frm=V3_POOL,
                to=TRADER,
                value=100 * 10**18,
                block=block,
                log_index=1,
                tx=tx,
            ),
        ]
    }
    head = block + 3
    fake = _install(monkeypatch, head, swap_logs, receipt_logs)

    dex_pitch_loop.tick()

    # The candidate WAS discovered (get_logs ran) but the deadline cut the receipt
    # loop before fetching any receipt → no rows, cursor NOT advanced.
    assert fake.eth.get_receipt_calls == [], "deadline must cut the receipt loop before any receipt"
    assert _count_rows() == 0
    assert state.get_int_key(dex_pitch_loop.CURSOR_KEY, -1) == -1, "cursor held for re-scan"


def test_tick_noop_when_from_block_above_head(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_cfg(monkeypatch, dex_scan_from_block=_FROM, reorg_lag_blocks=0)
    state.set_int_key(dex_pitch_loop.CURSOR_KEY, _FROM + 100)
    head = _FROM + 50  # below cursor
    fake = _install(monkeypatch, head, [])

    dex_pitch_loop.tick()

    assert fake.eth.get_logs_calls == [], "no get_logs when nothing to scan"
    assert _count_rows() == 0
