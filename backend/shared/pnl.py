"""Per-wallet PnL aggregation.

Port of the PnL block in portable ``api_trades`` (server.py §717-852). The
core formulas match the portable my_wallet view, with the following
differences from the original code structure:

- Pure function: ``(events, wallet_address, current_price) → WalletPosition``.
  Portable code mutated a ``wallets`` dict in-place while walking events.
- Filters by ``token_address`` outside this function (the caller usually knows
  the token from the URL / DB query). Keeps this function token-agnostic so it
  can be reused for the wallet-profile aggregation (multi-token).
- ``current_price`` is mandatory — portable read it from ``cache["prices"]``
  via ``current_price_of``. Caller passes 0.0 if unknown, in which case
  ``unrealized_pnl`` and ``total_pnl`` collapse to 0.
- ``position`` is clamped to 0 for display when float drift produces a
  ~1e-15 negative after a full sell-out. Portable rounded for the same reason.

Formulas (verbatim from portable my_wallet, kept in display units after dividing
by WEI). `avg_buy` here is **fee-inclusive** to match the portable wallet view
(`spent / bought`, not `(spent - buy_fees) / bought`). Reasoning: users care
about the actual amount they paid out of pocket; fees are then shown separately
in ``fees_paid`` for transparency, not double-counted.

    avg_buy    = spent / bought                      # fee-inclusive (portable parity)
    avg_net    = (spent - received) / position       # net cost basis
    realized   = received - avg_buy * sold           # avg-cost basis
    unrealized = position * (current_price - avg_buy)
    total_pnl  = realized + unrealized
"""

from __future__ import annotations

from shared.price import to_display_units
from shared.types import Event, WalletPosition

_TINY = 1e-9


def wallet_position(
    events: list[Event],
    wallet_address: str,
    current_price: float = 0.0,
) -> WalletPosition:
    """Aggregate ``events`` for ``wallet_address`` into a :class:`WalletPosition`.

    Args:
        events: Pre-filtered events (e.g. for a single token) sorted by block
            ASC. Out-of-order events still aggregate correctly — only
            ``first_trade_ts`` cares about order, and we use ``min(ts)``.
        wallet_address: Address to aggregate for. Case-insensitive (lowercased
            here, the event's ``trader_address`` is already lowercase).
        current_price: Spot price in the same base currency as ``base_value``
            (display units). 0.0 disables unrealized PnL.

    Returns:
        :class:`WalletPosition`. Returns a zeroed record (with the wallet
        address still set) if no events match — callers can distinguish empty
        wallets from missing data via ``buys + sells == 0``.
    """

    wallet = wallet_address.lower()

    buys = sells = 0
    position = 0.0  # net tokens held (in display units)
    spent = 0.0  # total base spent (PITCH paid out — fee included in transfer)
    received = 0.0  # total base received net of sell fees
    bought = 0.0  # gross tokens bought
    fees_paid = 0.0  # all fees (buy + sell), surfaced separately
    first_ts = 0  # earliest event ts seen

    for ev in events:
        if ev["trader_address"] != wallet:
            continue
        base_val = to_display_units(ev["base_value"])
        token_val = to_display_units(ev["token_value"])
        fee_val = to_display_units(ev["fee"])

        if ev["side"] == "buy":
            buys += 1
            position += token_val
            spent += base_val
            bought += token_val
        else:  # sell
            sells += 1
            position -= token_val
            received += base_val
        fees_paid += fee_val

        ts = ev["timestamp"]
        if ts > 0 and (first_ts == 0 or ts < first_ts):
            first_ts = ts

    # ``position`` can drift slightly negative or to dust (~1e-15) after a full
    # sell-out due to float arithmetic; clamp for display.
    display_position = position if position > _TINY else 0.0
    sold = max(bought - display_position, 0.0)

    # Fee-inclusive avg_buy (portable parity): the buyer pays ``spent`` in PITCH
    # and receives ``bought`` tokens; cost basis is the gross amount, not the
    # net-of-fee amount.
    avg_buy = (spent / bought) if bought > 0 else 0.0
    # Guard with a tiny epsilon — float position can be ~1e-15 after a full
    # sell-out, division would explode. Matches portable §782.
    avg_net = ((spent - received) / position) if position > _TINY else 0.0
    avg_net = max(avg_net, 0.0)

    realized = received - avg_buy * sold
    if current_price > 0 and position > _TINY:
        unrealized = position * (current_price - avg_buy)
    else:
        unrealized = 0.0
    total_pnl = realized + unrealized

    return {
        "address": wallet,
        "buys": buys,
        "sells": sells,
        "position": display_position,
        "spent": spent,
        "received": received,
        "bought": bought,
        "fees_paid": fees_paid,
        "avg_buy": avg_buy,
        "avg_net": avg_net,
        "realized_pnl": realized,
        "unrealized_pnl": unrealized,
        "total_pnl": total_pnl,
        "first_trade_ts": first_ts,
    }


__all__ = ["wallet_position"]
