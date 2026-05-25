"""Integration tests for the keeper main loop (B2.3).

Exercises :func:`worker.keeper.tick` against a real Postgres so we verify
the state-machine transitions (``pending → executing → filled`` /
``pending → executing → failed`` / ``pending → pending(cooldown)``) and
the SQL queries against the actual schema. The on-chain layer is mocked
— building a full anvil fork in pytest is out of scope for this task
(C2.4 already covers the fork-test side; here we want to verify the
keeper's *Python* glue between the DB rows and the executor contract).

Layout mirrors ``test_expiry.py``: clean ``limit_orders`` between tests,
seed one country token to satisfy the FK on ``token_address``, and
override config / w3 via ``patch.object``.
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from typing import Any
from unittest.mock import MagicMock, patch

import psycopg
import pytest
from psycopg.rows import dict_row

from worker import keeper

# Fixed deterministic addresses for the test rows.
_OWNER_ADDR = "0x" + "11" * 20
_COUNTRY_ADDR = "0x" + "aa" * 20
_EXECUTOR_ADDR = "0x" + "bb" * 20
# Valid 32-byte hex template for the `nonce` CHAR(66) column.
_NONCE_BASE = "0x" + "cd" * 31  # 62 hex chars after the 0x


def _nonce(idx: int) -> str:
    return _NONCE_BASE + f"{idx % 256:02x}"


@pytest.fixture(autouse=True)
def _seed_country(_clean_tokens_table) -> Iterator[None]:
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO tokens (address, name, symbol, kind, country_address, role) "
                "VALUES (%s, 'Brazil', 'BRA', 'country', NULL, NULL)",
                (_COUNTRY_ADDR,),
            )
            # market_state row with a current price low enough to trigger
            # a limit-buy with target=1000.
            cur.execute(
                "INSERT INTO market_state (token_address, price_country, price_pitch) "
                "VALUES (%s, 0, 500)",
                (_COUNTRY_ADDR,),
            )
        conn.commit()
    yield


@pytest.fixture(autouse=True)
def _clean_orders() -> Iterator[None]:
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM limit_orders")
            cur.execute("DELETE FROM user_settings")
        conn.commit()
    yield


@pytest.fixture(autouse=True)
def _reset_keeper_state() -> Iterator[None]:
    """Drop nonce / log-cooldown state between tests."""

    keeper._state.next_nonce = None
    keeper._state.last_nonce_resync_ts = 0.0
    keeper._state.last_skip_log_ts = 0.0
    yield


@pytest.fixture(autouse=True)
def _enable_keeper() -> Iterator[None]:
    """Patch the keeper config-accessors so the tick considers itself enabled.

    The Config dataclass is frozen — see :mod:`worker.keeper` "Config
    accessors" section for why we patch tiny indirection functions instead.
    """

    with (
        patch.object(keeper, "_get_keeper_private_key", return_value="0x" + "ab" * 64),
        patch.object(keeper, "_get_executor_contract", return_value=_EXECUTOR_ADDR),
        patch.object(keeper, "_get_gas_multiplier", return_value=1.5),
        patch.object(keeper, "_get_order_cooldown_sec", return_value=60),
    ):
        yield


def _insert_order(
    *,
    target_price: int = 1000,
    side: str = "limit-buy",
    status: str = "pending",
    retry_after_sec: int | None = None,
    attempts: int = 0,
    executed_tx_hash: str | None = None,
    nonce_idx: int = 0,
) -> int:
    """Insert one limit_order; return its id."""

    sql = (
        "INSERT INTO limit_orders ("
        " owner_address, token_address, quote_address, venue, side, "
        " target_price, amount_in, slippage_bps, nonce, signature, status, "
        " attempts, executed_tx_hash, retry_after) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"
        " CASE WHEN %s::int IS NULL THEN NULL "
        "      ELSE now() + make_interval(secs => %s::int) END) "
        "RETURNING id"
    )
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        with conn.cursor() as cur:
            cur.execute(
                sql,
                (
                    _OWNER_ADDR,
                    _COUNTRY_ADDR,
                    _COUNTRY_ADDR,
                    "country",
                    side,
                    target_price,
                    1_000_000_000_000_000_000,  # 1e18 amountIn
                    100,
                    _nonce(nonce_idx),
                    b"\x00" * 65,
                    status,
                    attempts,
                    executed_tx_hash,
                    retry_after_sec,
                    retry_after_sec,
                ),
            )
            row = cur.fetchone()
            assert row is not None
            oid = int(row["id"])
        conn.commit()
    return oid


def _row(order_id: int) -> dict[str, Any] | None:
    with (
        psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn,
        conn.cursor() as cur,
    ):
        cur.execute(
            "SELECT id, status, executed_tx_hash, fail_reason, fail_detail, attempts, "
            " retry_after IS NOT NULL AS has_retry_after "
            "FROM limit_orders WHERE id = %s",
            (order_id,),
        )
        row = cur.fetchone()
        return dict(row) if row is not None else None


def _make_mock_w3(
    *,
    simulate_raises: Exception | None = None,
    send_returns_hash: str | None = "0x" + "ee" * 32,
    send_raises: Exception | None = None,
    chain_nonce: int = 0,
) -> tuple[Any, Any]:
    """Build a w3 + contract pair that exercise the keeper's tx flow.

    Returns ``(w3, contract)``. The contract's ``functions.execute`` is
    wired so ``.call({"from": ...})`` honors ``simulate_raises`` and
    ``.build_transaction(...)`` returns a dict that w3.eth.estimate_gas
    accepts.
    """

    contract = MagicMock()
    execute_fn = MagicMock()
    contract.functions.execute.return_value = execute_fn

    def _call(*_args: Any, **_kwargs: Any) -> int:
        if simulate_raises is not None:
            raise simulate_raises
        return 1  # arbitrary success sentinel

    execute_fn.call.side_effect = _call
    execute_fn.build_transaction.return_value = {
        "from": "0x0000000000000000000000000000000000000000",
        "to": _EXECUTOR_ADDR,
        "data": "0xdeadbeef",
        "nonce": 0,
        "gasPrice": 1_000_000_000,
        "chainId": 8453,
    }

    w3 = MagicMock()
    w3.eth.gas_price = 1_000_000_000
    w3.eth.get_transaction_count.return_value = chain_nonce
    w3.eth.estimate_gas.return_value = 500_000

    def _send(_raw: Any) -> bytes:
        if send_raises is not None:
            raise send_raises
        assert send_returns_hash is not None
        h = send_returns_hash[2:] if send_returns_hash.startswith("0x") else send_returns_hash
        return bytes.fromhex(h)

    w3.eth.send_raw_transaction.side_effect = _send
    w3.eth.contract.return_value = contract
    return w3, contract


class TestKeeperTick:
    def test_disabled_when_key_missing(self) -> None:
        """No KEEPER_PRIVATE_KEY → tick is a no-op, no state mutated."""

        oid = _insert_order(nonce_idx=1)
        with patch.object(keeper, "_get_keeper_private_key", return_value=""):
            assert keeper.tick() == 0
        assert _row(oid)["status"] == "pending"

    def test_disabled_when_executor_zero_address(self) -> None:
        oid = _insert_order(nonce_idx=2)
        with patch.object(keeper, "_get_executor_contract", return_value="0x" + "00" * 20):
            assert keeper.tick() == 0
        assert _row(oid)["status"] == "pending"

    def test_happy_path_pending_to_executing(self) -> None:
        """Trigger + clean sim + clean send → row moves to ``executing``."""

        oid = _insert_order(target_price=1000, nonce_idx=3)
        w3, _contract = _make_mock_w3()

        # Mock the account so we don't need a real private key.
        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20
        fake_signed = MagicMock()
        fake_signed.raw_transaction = b"\xde\xad\xbe\xef"
        fake_account.sign_transaction.return_value = fake_signed

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
            patch.object(keeper, "notify", return_value=None),
        ):
            touched = keeper.tick()

        assert touched == 1
        row = _row(oid)
        assert row["status"] == "executing"
        assert row["executed_tx_hash"] is not None
        assert row["executed_tx_hash"].strip().startswith("0x")
        assert row["attempts"] == 1
        # Local nonce counter should have advanced.
        assert keeper._state.next_nonce == 1

    def test_price_not_yet_met_skipped(self) -> None:
        """Trigger predicate False → no simulate, no send."""

        # Limit-buy with target 100 but market is 500 → does NOT trigger.
        oid = _insert_order(target_price=100, nonce_idx=4)
        w3, contract = _make_mock_w3()

        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
        ):
            touched = keeper.tick()

        assert touched == 0
        assert _row(oid)["status"] == "pending"
        # Simulation must not have been attempted.
        contract.functions.execute.assert_not_called()

    def test_simulation_retryable_revert_sets_cooldown(self) -> None:
        """``PriceConditionNotMet`` from sim → keep pending, set retry_after."""

        from web3 import Web3

        sel = "0x" + Web3.keccak(text="PriceConditionNotMet()")[:4].hex()

        class _MockRevert(Exception):
            def __init__(self) -> None:
                super().__init__("execution reverted")
                self.data = sel

        oid = _insert_order(target_price=1000, nonce_idx=5)
        w3, _contract = _make_mock_w3(simulate_raises=_MockRevert())

        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
            patch.object(keeper, "notify", return_value=None),
        ):
            touched = keeper.tick()

        assert touched == 1
        row = _row(oid)
        assert row["status"] == "pending"
        assert row["has_retry_after"] is True
        assert row["fail_reason"] == "router_revert"
        assert row["fail_detail"] == "PriceConditionNotMet"
        # send_raw_transaction must not be called when simulation rejected.
        w3.eth.send_raw_transaction.assert_not_called()

    def test_simulation_terminal_revert_marks_failed(self) -> None:
        """``NonceAlreadyUsed`` from sim → mark failed permanently."""

        from web3 import Web3

        sel = "0x" + Web3.keccak(text="NonceAlreadyUsed()")[:4].hex()

        class _MockRevert(Exception):
            def __init__(self) -> None:
                super().__init__("execution reverted")
                self.data = sel

        oid = _insert_order(target_price=1000, nonce_idx=6)
        w3, _contract = _make_mock_w3(simulate_raises=_MockRevert())

        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
            patch.object(keeper, "notify", return_value=None),
        ):
            touched = keeper.tick()

        assert touched == 1
        row = _row(oid)
        assert row["status"] == "failed"
        assert row["fail_reason"] == "nonce_used"
        assert row["fail_detail"] == "NonceAlreadyUsed"
        w3.eth.send_raw_transaction.assert_not_called()

    def test_disarmed_user_orders_skipped(self) -> None:
        """``user_settings.orders_armed=false`` → never picked up by select_armed."""

        oid = _insert_order(target_price=1000, nonce_idx=7)
        with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO user_settings (owner_address, orders_armed) VALUES (%s, false)",
                    (_OWNER_ADDR,),
                )
            conn.commit()

        w3, contract = _make_mock_w3()
        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
        ):
            touched = keeper.tick()

        assert touched == 0
        assert _row(oid)["status"] == "pending"
        contract.functions.execute.assert_not_called()

    def test_retry_after_in_future_skipped(self) -> None:
        """``retry_after > now()`` → ignored this tick."""

        oid = _insert_order(target_price=1000, nonce_idx=8, retry_after_sec=300)

        w3, contract = _make_mock_w3()
        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
        ):
            touched = keeper.tick()

        assert touched == 0
        contract.functions.execute.assert_not_called()
        assert _row(oid)["status"] == "pending"

    def test_attempts_exhausted_marks_failed(self) -> None:
        """``attempts >= MAX_ATTEMPTS`` → straight to failed without sim/send."""

        oid = _insert_order(
            target_price=1000,
            nonce_idx=9,
            attempts=keeper.MAX_ATTEMPTS,
        )
        w3, contract = _make_mock_w3()
        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
            patch.object(keeper, "notify", return_value=None),
        ):
            keeper.tick()

        row = _row(oid)
        assert row["status"] == "failed"
        assert row["fail_reason"] == "unknown"
        contract.functions.execute.assert_not_called()

    def test_receipt_polling_success_marks_filled(self) -> None:
        """Executing row + receipt status=1 + OrderExecuted log → ``filled``."""

        oid = _insert_order(
            status="executing",
            executed_tx_hash="0x" + "ab" * 32,
            nonce_idx=10,
        )

        w3, contract = _make_mock_w3()
        # Receipt with status=1 (success).
        w3.eth.get_transaction_receipt.return_value = {
            "status": 1,
            "blockNumber": 12345,
        }
        # OrderExecuted process_receipt → non-empty list = event present.
        contract.events.OrderExecuted.return_value.process_receipt.return_value = [
            {"args": {"owner": _OWNER_ADDR}}
        ]

        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
            patch.object(keeper, "notify", return_value=None),
        ):
            keeper.tick()

        assert _row(oid)["status"] == "filled"

    def test_receipt_status_zero_terminal_marks_failed(self) -> None:
        """Receipt status=0 + terminal revert (NonceAlreadyUsed) → ``failed``."""

        from web3 import Web3

        sel = "0x" + Web3.keccak(text="NonceAlreadyUsed()")[:4].hex()

        oid = _insert_order(
            status="executing",
            executed_tx_hash="0x" + "ab" * 32,
            nonce_idx=11,
        )

        w3, _contract = _make_mock_w3()
        w3.eth.get_transaction_receipt.return_value = {
            "status": 0,
            "blockNumber": 12345,
        }
        # Replay via eth_call → raises with the selector in `.data`.
        w3.eth.get_transaction.return_value = {
            "from": "0x" + "f1" * 20,
            "to": _EXECUTOR_ADDR,
            "input": "0xdeadbeef",
            "value": 0,
            "gas": 500_000,
        }

        class _Revert(Exception):
            def __init__(self) -> None:
                super().__init__("execution reverted")
                self.data = sel

        w3.eth.call.side_effect = _Revert()

        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
            patch.object(keeper, "notify", return_value=None),
        ):
            keeper.tick()

        row = _row(oid)
        assert row["status"] == "failed"
        assert row["fail_reason"] == "nonce_used"

    def test_receipt_status_zero_retryable_returns_to_pending(self) -> None:
        """Receipt status=0 + ``PriceConditionNotMet`` → back to pending + cooldown."""

        from web3 import Web3

        sel = "0x" + Web3.keccak(text="PriceConditionNotMet()")[:4].hex()

        oid = _insert_order(
            status="executing",
            executed_tx_hash="0x" + "ab" * 32,
            nonce_idx=12,
        )

        w3, _contract = _make_mock_w3()
        w3.eth.get_transaction_receipt.return_value = {
            "status": 0,
            "blockNumber": 12345,
        }
        w3.eth.get_transaction.return_value = {
            "from": "0x" + "f1" * 20,
            "to": _EXECUTOR_ADDR,
            "input": "0xdeadbeef",
            "value": 0,
            "gas": 500_000,
        }

        class _Revert(Exception):
            def __init__(self) -> None:
                super().__init__("execution reverted")
                self.data = sel

        w3.eth.call.side_effect = _Revert()

        fake_account = MagicMock()
        fake_account.address = "0x" + "f1" * 20

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "_keeper_account", return_value=fake_account),
            patch.object(keeper, "notify", return_value=None),
        ):
            keeper.tick()

        row = _row(oid)
        assert row["status"] == "pending"
        assert row["executed_tx_hash"] is None
        assert row["has_retry_after"] is True
        assert row["fail_reason"] == "router_revert"


class TestKeeperRecovery:
    def test_recovery_skip_when_disabled(self) -> None:
        oid = _insert_order(status="executing", executed_tx_hash="0x" + "12" * 32, nonce_idx=20)
        with patch.object(keeper, "_get_keeper_private_key", return_value=""):
            keeper.run_recovery()
        # Still executing — recovery skipped silently.
        assert _row(oid)["status"] == "executing"

    def test_recovery_marks_confirmed_row_filled(self) -> None:
        oid = _insert_order(status="executing", executed_tx_hash="0x" + "13" * 32, nonce_idx=21)

        w3, contract = _make_mock_w3()
        w3.eth.get_transaction_receipt.return_value = {"status": 1, "blockNumber": 1}
        contract.events.OrderExecuted.return_value.process_receipt.return_value = [
            {"args": {"owner": _OWNER_ADDR}}
        ]

        with (
            patch.object(keeper._w3, "get_w3", return_value=w3),
            patch.object(keeper, "notify", return_value=None),
        ):
            keeper.run_recovery()

        assert _row(oid)["status"] == "filled"
