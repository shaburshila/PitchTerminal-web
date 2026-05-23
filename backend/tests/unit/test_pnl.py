"""Unit tests for :mod:`shared.pnl`.

Scenarios replicate the portable behaviour in ``api_trades`` (server.py
§717-852). Numbers chosen so that hand-computing PnL is easy.
"""

from __future__ import annotations

from shared.config import WEI
from shared.pnl import wallet_position
from shared.types import Event

WALLET = "0xaaaa000000000000000000000000000000000001"
OTHER = "0xbbbb000000000000000000000000000000000002"


def _ev(
    *,
    side: str,
    base: int,
    token: int,
    fee: int = 0,
    trader: str = WALLET,
    block: int = 1,
    ts: int = 1000,
    log_index: int = 0,
) -> Event:
    return {
        "block_number": block,
        "tx_hash": "0x" + "00" * 32,
        "log_index": log_index,
        "token_address": "0xcccc000000000000000000000000000000000003",
        "side": side,  # type: ignore[typeddict-item]
        "trader_address": trader,
        "base_value": base,
        "token_value": token,
        "fee": fee,
        "timestamp": ts,
    }


class TestWalletPosition:
    def test_no_events_returns_zeroed(self) -> None:
        wp = wallet_position([], WALLET)
        assert wp["address"] == WALLET
        assert wp["buys"] == 0
        assert wp["sells"] == 0
        assert wp["position"] == 0.0
        assert wp["realized_pnl"] == 0.0
        assert wp["unrealized_pnl"] == 0.0
        assert wp["total_pnl"] == 0.0
        assert wp["first_trade_ts"] == 0

    def test_filters_by_wallet(self) -> None:
        events = [
            _ev(side="buy", base=10 * WEI, token=1 * WEI, trader=OTHER),
            _ev(side="buy", base=20 * WEI, token=2 * WEI, trader=WALLET),
        ]
        wp = wallet_position(events, WALLET)
        assert wp["buys"] == 1
        assert wp["position"] == 2.0
        assert wp["spent"] == 20.0

    def test_buy_then_sell_full_realized(self) -> None:
        # Buy 1 token for 10, then sell 1 token for 15. Realized = +5.
        events = [
            _ev(side="buy", base=10 * WEI, token=1 * WEI, block=1, ts=100),
            _ev(side="sell", base=15 * WEI, token=1 * WEI, block=2, ts=200),
        ]
        wp = wallet_position(events, WALLET, current_price=99.0)
        assert wp["buys"] == 1
        assert wp["sells"] == 1
        assert wp["position"] == 0.0  # fully closed
        assert wp["bought"] == 1.0
        assert wp["spent"] == 10.0
        assert wp["received"] == 15.0
        # avg_buy = (10 - 0) / 1 = 10. sold = 1. realized = 15 - 10*1 = 5.
        assert wp["avg_buy"] == 10.0
        assert wp["realized_pnl"] == 5.0
        # Position is zero → unrealized must be 0 (current_price irrelevant).
        assert wp["unrealized_pnl"] == 0.0
        assert wp["total_pnl"] == 5.0
        assert wp["first_trade_ts"] == 100

    def test_unrealized_with_current_price(self) -> None:
        # Buy 2 tokens at price 10 each → at current_price=12, unrealized = 2*(12-10)=4.
        events = [_ev(side="buy", base=20 * WEI, token=2 * WEI, ts=500)]
        wp = wallet_position(events, WALLET, current_price=12.0)
        assert wp["position"] == 2.0
        assert wp["avg_buy"] == 10.0
        assert wp["unrealized_pnl"] == 4.0
        assert wp["realized_pnl"] == 0.0  # nothing sold yet
        assert wp["total_pnl"] == 4.0

    def test_avg_buy_weights_multiple_buys(self) -> None:
        # Buy 1@10 (fee 0), Buy 3@20 (fee 0). avg_buy = (10+60)/4 = 17.5.
        events = [
            _ev(side="buy", base=10 * WEI, token=1 * WEI, block=1),
            _ev(side="buy", base=60 * WEI, token=3 * WEI, block=2),
        ]
        wp = wallet_position(events, WALLET)
        assert wp["bought"] == 4.0
        assert wp["spent"] == 70.0
        assert wp["avg_buy"] == 17.5

    def test_buy_fees_excluded_from_avg_buy(self) -> None:
        # avg_buy uses (spent - buy_fees) / bought (market price).
        # Buy: paid 11 (incl 1 fee), got 1 token → avg_buy = (11-1)/1 = 10.
        events = [_ev(side="buy", base=11 * WEI, token=1 * WEI, fee=1 * WEI)]
        wp = wallet_position(events, WALLET)
        assert wp["avg_buy"] == 10.0
        assert wp["spent"] == 11.0
        assert wp["fees_paid"] == 1.0

    def test_avg_net_is_fee_inclusive_breakeven(self) -> None:
        # Buy 2 for 22 (incl 2 fee), sell 1 for 8 (net of 1 fee).
        # spent=22, received=8, position=1 → avg_net = (22-8)/1 = 14.
        events = [
            _ev(side="buy", base=22 * WEI, token=2 * WEI, fee=2 * WEI),
            _ev(side="sell", base=8 * WEI, token=1 * WEI, fee=1 * WEI),
        ]
        wp = wallet_position(events, WALLET)
        assert wp["position"] == 1.0
        assert wp["received"] == 8.0
        assert wp["avg_net"] == 14.0

    def test_partial_sell_realized_uses_avg_buy(self) -> None:
        # Buy 4@10 (fee 0), sell 2@15. realized = 30 - 10*2 = 10. position=2.
        events = [
            _ev(side="buy", base=40 * WEI, token=4 * WEI, block=1, ts=100),
            _ev(side="sell", base=30 * WEI, token=2 * WEI, block=2, ts=200),
        ]
        wp = wallet_position(events, WALLET, current_price=15.0)
        assert wp["position"] == 2.0
        assert wp["avg_buy"] == 10.0
        assert wp["realized_pnl"] == 10.0
        assert wp["unrealized_pnl"] == 10.0  # 2 * (15 - 10)
        assert wp["total_pnl"] == 20.0

    def test_fees_accumulate(self) -> None:
        events = [
            _ev(side="buy", base=10 * WEI, token=1 * WEI, fee=1 * WEI),
            _ev(side="sell", base=10 * WEI, token=1 * WEI, fee=2 * WEI),
        ]
        wp = wallet_position(events, WALLET)
        assert wp["fees_paid"] == 3.0

    def test_first_trade_ts_is_min(self) -> None:
        # Out-of-order events → still picks the earliest ts.
        events = [
            _ev(side="buy", base=10 * WEI, token=1 * WEI, ts=500),
            _ev(side="buy", base=10 * WEI, token=1 * WEI, ts=100),
            _ev(side="buy", base=10 * WEI, token=1 * WEI, ts=300),
        ]
        wp = wallet_position(events, WALLET)
        assert wp["first_trade_ts"] == 100

    def test_zero_timestamps_ignored_for_first_trade(self) -> None:
        events = [
            _ev(side="buy", base=10 * WEI, token=1 * WEI, ts=0),
            _ev(side="buy", base=10 * WEI, token=1 * WEI, ts=500),
        ]
        wp = wallet_position(events, WALLET)
        assert wp["first_trade_ts"] == 500

    def test_address_lowercased(self) -> None:
        mixed = "0xAAAA000000000000000000000000000000000001"
        events = [_ev(side="buy", base=10 * WEI, token=1 * WEI)]
        wp = wallet_position(events, mixed)
        assert wp["address"] == mixed.lower()

    def test_no_current_price_no_unrealized(self) -> None:
        events = [_ev(side="buy", base=10 * WEI, token=1 * WEI)]
        wp = wallet_position(events, WALLET, current_price=0.0)
        assert wp["unrealized_pnl"] == 0.0
        assert wp["total_pnl"] == 0.0

    def test_fully_closed_avg_net_zero(self) -> None:
        # After full sell-out position ~ 0 → avg_net guarded by epsilon.
        events = [
            _ev(side="buy", base=10 * WEI, token=1 * WEI),
            _ev(side="sell", base=10 * WEI, token=1 * WEI),
        ]
        wp = wallet_position(events, WALLET)
        assert wp["position"] == 0.0
        assert wp["avg_net"] == 0.0
