"""pitchwc bonding-curve fee helpers.

The pitchwc.app bonding-curve hook charges a flat protocol fee on every
swap (currently 5% / 500 bps). At any instant a token has THREE prices:

* ``MID`` — fee-free curve price returned by ``Hook.currentPrice(token)``;
  this is what the chart shows.
* ``ASK`` — what a buyer effectively pays = ``MID / (1 - fee)``; in display
  units, ``ASK = MID / 0.95`` for the default 5% fee.
* ``BID`` — what a seller effectively receives = ``MID × (1 - fee)``;
  ``BID = MID × 0.95`` for the default 5% fee.

Two conversions are needed:

* :func:`execution_to_mid` — given an execution-space price (ASK for a
  buy, BID for a sell), produce the MID. Used by the keeper to derive a
  MID-space trigger target from the legacy ``target_price`` column when
  ``display_target_price`` is NULL (pre-migration-0004 rows).
* :func:`mid_to_execution` — inverse: convert a user-typed MID target to
  the execution-space value the on-chain contract verifies. Not used by
  backend (the frontend EIP-712 signer handles that), but exposed here
  for cross-language parity and tests.

``FEE_BPS`` is hardcoded at the current pitchwc value. If pitchwc ever
changes the fee, this constant must be updated **and** any rows with a
NULL ``display_target_price`` re-derived (or re-signed by users). Querying
the fee on-chain per-call would add an RPC round-trip to every keeper
tick; the constant is documented in :mod:`docs/architecture.md` §7.1.
"""

from __future__ import annotations

from decimal import Decimal

#: pitchwc protocol fee in basis points. Hardcoded — see module docstring.
FEE_BPS: int = 500

#: ``1 - FEE_BPS/10000`` as a high-precision Decimal. The keeper does its
#: trigger math in integer wei, so we expose both the bps constant and the
#: factor; arithmetic helpers below convert via integer * bps / 10000 to
#: avoid float drift.
FEE_FACTOR: Decimal = Decimal(10_000 - FEE_BPS) / Decimal(10_000)


def execution_to_mid_wei(execution_price_wei: int, side: str) -> int:
    """Convert a wei-denominated execution price to a wei-denominated MID.

    Args:
        execution_price_wei: Price in execution-space (ASK for buy / BID for
            sell), denominated in quote-wei per 1 whole base (10^18).
        side: ``"limit-buy"`` or ``"buy"`` for a buy order; ``"take-profit"``
            or ``"sell"`` for a sell order. The order ``side`` enum and the
            event ``side`` enum disagree on labels; this helper accepts
            either family.

    Returns:
        Wei-denominated MID. Computed with integer arithmetic
        (``execution × (10000 - FEE_BPS) // 10000`` for buys,
        ``execution × 10000 // (10000 - FEE_BPS)`` for sells) so the
        keeper's trigger comparison stays exact.

    A 5% fee gives the following round-trip:

    >>> execution_to_mid_wei(10_526_315_789_473_684_210, "limit-buy")
    9_999_999_999_999_999_999

    (One-wei rounding loss is expected — the round-trip is not lossless
    for arbitrary wei amounts, but the loss is bounded by ``10**18``-wei
    precision which is far below any sensible price granularity.)
    """

    if execution_price_wei <= 0:
        raise ValueError(f"execution_price_wei must be positive, got {execution_price_wei}")

    s = side.lower()
    factor_num = 10_000 - FEE_BPS  # e.g. 9500
    factor_den = 10_000

    if s in ("limit-buy", "buy"):
        # Buy: execution = MID / (1 - fee) ⇒ MID = execution × (1 - fee).
        return (execution_price_wei * factor_num) // factor_den
    if s in ("take-profit", "sell"):
        # Sell: execution = MID × (1 - fee) ⇒ MID = execution / (1 - fee).
        return (execution_price_wei * factor_den) // factor_num
    raise ValueError(f"unknown side: {side!r}")


def mid_to_execution_wei(mid_price_wei: int, side: str) -> int:
    """Inverse of :func:`execution_to_mid_wei`.

    Returns the execution-space price the on-chain contract verifies for
    an order whose MID-space target is ``mid_price_wei``. Mirrors the math
    used by the frontend EIP-712 signer; kept in Python for tests + parity.
    """

    if mid_price_wei <= 0:
        raise ValueError(f"mid_price_wei must be positive, got {mid_price_wei}")

    s = side.lower()
    factor_num = 10_000 - FEE_BPS
    factor_den = 10_000

    if s in ("limit-buy", "buy"):
        # MID = execution × (1 - fee) ⇒ execution = MID / (1 - fee).
        return (mid_price_wei * factor_den) // factor_num
    if s in ("take-profit", "sell"):
        # MID = execution / (1 - fee) ⇒ execution = MID × (1 - fee).
        return (mid_price_wei * factor_num) // factor_den
    raise ValueError(f"unknown side: {side!r}")


def event_price_to_mid(execution_price: Decimal | float, side: str) -> Decimal:
    """Display-units version of :func:`execution_to_mid_wei`.

    Convenience for chart code that already works in float / Decimal
    display units instead of wei. The chart pipeline in
    :mod:`shared.chart` / :mod:`shared.price` actually computes the MID
    directly from event ``base_value`` / ``fee`` / ``token_value`` (via
    ``shared.price.market_price``) and does NOT need this helper — it's
    exposed here for callers that only have the raw execution rate.
    """

    if not isinstance(execution_price, Decimal):
        execution_price = Decimal(str(execution_price))
    if execution_price <= 0:
        raise ValueError(f"execution_price must be positive, got {execution_price}")

    s = side.lower()
    if s in ("limit-buy", "buy"):
        return execution_price * FEE_FACTOR
    if s in ("take-profit", "sell"):
        return execution_price / FEE_FACTOR
    raise ValueError(f"unknown side: {side!r}")


__all__ = [
    "FEE_BPS",
    "FEE_FACTOR",
    "event_price_to_mid",
    "execution_to_mid_wei",
    "mid_to_execution_wei",
]
