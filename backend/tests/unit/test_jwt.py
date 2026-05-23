"""Unit tests for :mod:`shared.jwt` (HS256 encode/decode)."""

from __future__ import annotations

import time
from unittest.mock import patch

import jwt as pyjwt
import pytest

from shared import jwt as jwt_mod
from shared.jwt import JwtExpired, JwtInvalid, decode, encode


class TestEncode:
    def test_lowercases_address(self) -> None:
        token = encode("0x71ECD1A09380CA46CCA741BC48D04C556674756F")
        addr = decode(token)
        assert addr == "0x71ecd1a09380ca46cca741bc48d04c556674756f"

    def test_includes_required_claims(self) -> None:
        token = encode("0x" + "ab" * 20)
        # Decode without verification to inspect claims.
        claims = pyjwt.decode(token, options={"verify_signature": False})
        assert claims["iss"] == "pitchterminal-api"
        assert claims["aud"] == "pitchterminal-web"
        assert claims["sub"] == "0x" + "ab" * 20
        assert "iat" in claims and "exp" in claims
        assert claims["exp"] - claims["iat"] == 72 * 3600

    def test_custom_ttl(self) -> None:
        token = encode("0x" + "cd" * 20, ttl_seconds=60)
        claims = pyjwt.decode(token, options={"verify_signature": False})
        assert claims["exp"] - claims["iat"] == 60


class TestDecode:
    def test_round_trip(self) -> None:
        addr = "0x" + "ef" * 20
        assert decode(encode(addr)) == addr

    def test_expired_raises_jwt_expired(self) -> None:
        # iat in the past, exp also in the past.
        token = encode("0x" + "ab" * 20, ttl_seconds=-10)
        with pytest.raises(JwtExpired):
            decode(token)

    def test_bad_signature_raises_jwt_invalid(self) -> None:
        token = encode("0x" + "ab" * 20)
        # Flip a character in the signature portion.
        head, payload, sig = token.split(".")
        tampered = ".".join([head, payload, sig[:-2] + ("aa" if sig[-2:] != "aa" else "bb")])
        with pytest.raises(JwtInvalid):
            decode(tampered)

    def test_malformed_raises_jwt_invalid(self) -> None:
        with pytest.raises(JwtInvalid):
            decode("not-a-jwt")

    def test_wrong_audience_raises_jwt_invalid(self) -> None:
        now = int(time.time())
        from shared.config import config

        bad = pyjwt.encode(
            {
                "iss": "pitchterminal-api",
                "aud": "other-aud",
                "sub": "0x" + "ab" * 20,
                "iat": now,
                "exp": now + 3600,
            },
            config.jwt_secret,
            algorithm="HS256",
        )
        with pytest.raises(JwtInvalid):
            decode(bad)

    def test_wrong_issuer_raises_jwt_invalid(self) -> None:
        now = int(time.time())
        from shared.config import config

        bad = pyjwt.encode(
            {
                "iss": "other-iss",
                "aud": "pitchterminal-web",
                "sub": "0x" + "ab" * 20,
                "iat": now,
                "exp": now + 3600,
            },
            config.jwt_secret,
            algorithm="HS256",
        )
        with pytest.raises(JwtInvalid):
            decode(bad)

    def test_missing_sub_raises_jwt_invalid(self) -> None:
        now = int(time.time())
        from shared.config import config

        # pyjwt won't let us drop `sub` via `require`, but we can encode it
        # malformed and trigger the post-decode check.
        bad = pyjwt.encode(
            {
                "iss": "pitchterminal-api",
                "aud": "pitchterminal-web",
                "sub": "not-an-address",
                "iat": now,
                "exp": now + 3600,
            },
            config.jwt_secret,
            algorithm="HS256",
        )
        with pytest.raises(JwtInvalid):
            decode(bad)

    def test_error_codes(self) -> None:
        # Stable strings for problem+json serialization.
        assert JwtExpired.code == "auth.jwt.expired"
        assert JwtInvalid.code == "auth.unauthenticated"

    def test_decode_uses_current_secret(self) -> None:
        """Rotating jwt_secret invalidates outstanding tokens.

        Frozen dataclass — we replace the whole `config` reference in the
        module under test.
        """

        original = encode("0x" + "ab" * 20)
        from dataclasses import replace

        rotated = replace(
            jwt_mod.config,
            jwt_secret="totally-different-secret-with-32+chars!",
        )
        with patch.object(jwt_mod, "config", rotated), pytest.raises(JwtInvalid):
            decode(original)
