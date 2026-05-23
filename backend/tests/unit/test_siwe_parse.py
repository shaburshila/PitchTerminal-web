"""Unit tests for :mod:`shared.siwe` — message parsing and policy checks.

DB interactions (``execute``, ``fetch_one``) are mocked, so these tests run
without a Postgres instance.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct
from siwe import SiweMessage

from shared import siwe as siwe_mod
from shared.siwe import (
    ExpiredMessage,
    InvalidDomain,
    InvalidNonce,
    InvalidSignature,
    verify_message,
)


def _build_message(
    *,
    address: str,
    domain: str = "pitchterminal.app",
    uri: str = "https://pitchterminal.app",
    chain_id: int = 8453,
    nonce: str = "abcdefgh12345678",
    issued_at: datetime | None = None,
    expiration_time: datetime | None = None,
) -> str:
    issued_at = issued_at or datetime.now(UTC).replace(microsecond=0)
    expiration_time = expiration_time or (issued_at + timedelta(minutes=5))
    msg = SiweMessage(
        domain=domain,
        address=address,
        uri=uri,
        version="1",
        chain_id=chain_id,
        nonce=nonce,
        issued_at=issued_at.isoformat().replace("+00:00", "Z"),
        expiration_time=expiration_time.isoformat().replace("+00:00", "Z"),
        statement="Sign in to PitchTerminal.",
    )
    return msg.prepare_message()


def _sign(message: str, private_key: str) -> str:
    encoded = encode_defunct(text=message)
    signed = Account.sign_message(encoded, private_key=private_key)
    hex_sig = signed.signature.hex()
    return hex_sig if hex_sig.startswith("0x") else "0x" + hex_sig


@pytest.fixture()
def wallet() -> tuple[str, str]:
    """Fresh test wallet — returns ``(address_checksum, private_key_hex)``."""

    acct = Account.create()
    return acct.address, acct.key.hex()


@pytest.fixture()
def fresh_nonce_row():
    """Patch ``shared.siwe.fetch_one`` so the atomic nonce-consume succeeds.

    After the C-1 fix the nonce check is a single `DELETE ... RETURNING`
    query, so a successful consume looks like `fetch_one` returning a row.
    """

    with (
        patch.object(siwe_mod, "fetch_one") as fo,
        patch.object(siwe_mod, "execute") as ex,
    ):
        fo.return_value = {"created_at": datetime.now(UTC)}
        ex.return_value = 1
        yield fo, ex


class TestVerifyHappyPath:
    def test_valid_message_passes(self, wallet, fresh_nonce_row) -> None:
        address, pk = wallet
        msg = _build_message(address=address)
        sig = _sign(msg, pk)
        verify_message(msg, sig, address)


class TestPolicyChecks:
    def test_wrong_domain(self, wallet, fresh_nonce_row) -> None:
        address, pk = wallet
        msg = _build_message(address=address, domain="evil.example")
        sig = _sign(msg, pk)
        with pytest.raises(InvalidDomain):
            verify_message(msg, sig, address)

    def test_wrong_uri(self, wallet, fresh_nonce_row) -> None:
        address, pk = wallet
        msg = _build_message(address=address, uri="https://evil.example")
        sig = _sign(msg, pk)
        with pytest.raises(InvalidDomain):
            verify_message(msg, sig, address)

    def test_wrong_chain(self, wallet, fresh_nonce_row) -> None:
        address, pk = wallet
        msg = _build_message(address=address, chain_id=1)
        sig = _sign(msg, pk)
        with pytest.raises(InvalidDomain):
            verify_message(msg, sig, address)

    def test_address_mismatch(self, wallet, fresh_nonce_row) -> None:
        address, pk = wallet
        msg = _build_message(address=address)
        sig = _sign(msg, pk)
        other = "0x" + "ff" * 20
        with pytest.raises(InvalidSignature):
            verify_message(msg, sig, other)


class TestNonceChecks:
    def test_missing_nonce(self, wallet) -> None:
        address, pk = wallet
        msg = _build_message(address=address)
        sig = _sign(msg, pk)
        with (
            patch.object(siwe_mod, "fetch_one", return_value=None),
            patch.object(siwe_mod, "execute", return_value=0),
            pytest.raises(InvalidNonce),
        ):
            verify_message(msg, sig, address)

    def test_stale_nonce(self, wallet) -> None:
        address, pk = wallet
        msg = _build_message(address=address)
        sig = _sign(msg, pk)
        # The atomic DELETE+check applies the `created_at > cutoff` predicate
        # at the SQL level: a stale row simply doesn't match, so fetch_one
        # returns None and InvalidNonce is raised.
        with (
            patch.object(siwe_mod, "fetch_one", return_value=None),
            patch.object(siwe_mod, "execute", return_value=1),
            pytest.raises(InvalidNonce),
        ):
            verify_message(msg, sig, address)


class TestExpiration:
    def test_expired_message(self, wallet, fresh_nonce_row) -> None:
        address, pk = wallet
        past = datetime.now(UTC) - timedelta(hours=1)
        msg = _build_message(
            address=address,
            issued_at=past - timedelta(minutes=5),
            expiration_time=past,
        )
        sig = _sign(msg, pk)
        with pytest.raises(ExpiredMessage):
            verify_message(msg, sig, address)


class TestSignatureChecks:
    def test_signature_from_other_key(self, wallet, fresh_nonce_row) -> None:
        address, _pk = wallet
        other_pk = Account.create().key.hex()
        msg = _build_message(address=address)
        sig = _sign(msg, other_pk)
        with pytest.raises(InvalidSignature):
            verify_message(msg, sig, address)

    def test_malformed_message(self, fresh_nonce_row) -> None:
        with pytest.raises(InvalidSignature):
            verify_message("this is not a SIWE message", "0x00", "0x" + "aa" * 20)


class TestNonceConsumption:
    def test_consumed_on_success(self, wallet) -> None:
        address, pk = wallet
        msg = _build_message(address=address)
        sig = _sign(msg, pk)
        # After the C-1 fix the consume is a single `DELETE ... RETURNING`
        # query routed through `fetch_one`. A successful verify must hit
        # that path exactly once with a DELETE statement.
        with (
            patch.object(
                siwe_mod, "fetch_one",
                return_value={"created_at": datetime.now(UTC)},
            ) as fo,
            patch.object(siwe_mod, "execute", return_value=1),
        ):
            verify_message(msg, sig, address)
        delete_calls = [c for c in fo.call_args_list if "DELETE" in c.args[0]]
        assert delete_calls, "expected atomic DELETE...RETURNING on nonce"

    def test_not_consumed_on_failure(self, wallet) -> None:
        address, pk = wallet
        msg = _build_message(address=address, domain="evil.example")
        sig = _sign(msg, pk)
        with (
            patch.object(
                siwe_mod, "fetch_one",
                return_value={"created_at": datetime.now(UTC)},
            ),
            patch.object(siwe_mod, "execute", return_value=1) as ex,
            pytest.raises(InvalidDomain),
        ):
            verify_message(msg, sig, address)
        # InvalidDomain happens before the nonce check, so no DELETE at all.
        delete_calls = [c for c in ex.call_args_list if "DELETE" in c.args[0]]
        assert not delete_calls


class TestErrorCodes:
    def test_codes_match_api_spec(self) -> None:
        assert InvalidSignature.code == "auth.siwe.invalid_signature"
        assert InvalidNonce.code == "auth.siwe.invalid_nonce"
        assert InvalidDomain.code == "auth.siwe.invalid_domain"
        assert ExpiredMessage.code == "auth.siwe.expired_message"
