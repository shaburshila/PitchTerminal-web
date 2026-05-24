// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IHook } from "../../src/interfaces/IHook.sol";

/// @notice Test double for the pitchwc Hook. Returns a per-token price set by
///         the test, with a global multiplier so the price observed by
///         `currentPrice` can be made to disagree with the quote returned by
///         `quoteBuy` / `quoteSell` (used for slippage / sandwich tests).
/// @dev Deterministic, no randomness. Token argument is honored so tests can
///      stub multiple tokens at once.
contract MockHook is IHook {
    /// @notice 1e18-fixed-point price set per token.
    mapping(address => uint256) public priceOf;

    /// @notice Multiplier in basis points (10_000 = 1.0) applied to the
    ///         quote calculation only — leaves `currentPrice` untouched so
    ///         tests can simulate execution-time slippage.
    uint256 public quoteMultiplierBps;

    uint256 private constant ONE = 1e18;
    uint256 private constant BPS_DENOM = 10_000;

    constructor(uint256 initialPrice) {
        // Default applies the initial price to address(0) so any unset token
        // returns it; explicit `setPrice(token, p)` overrides for real tokens.
        priceOf[address(0)] = initialPrice;
        quoteMultiplierBps = BPS_DENOM;
    }

    // ── Setters (test-only) ────────────────────────────────────────────────

    function setPrice(address token, uint256 newPrice) external {
        priceOf[token] = newPrice;
    }

    function setQuoteMultiplier(uint256 bps) external {
        quoteMultiplierBps = bps;
    }

    // ── IHook ──────────────────────────────────────────────────────────────

    function currentPrice(address token) external view returns (uint256) {
        return _priceFor(token);
    }

    /// @dev quoteBuy: spending `quoteIn` of quote → how many of base.
    ///      base = quoteIn * 1e18 / price * mult / 10_000.
    function quoteBuy(address token, uint256 quoteIn) external view returns (uint256 baseOut) {
        uint256 price = _priceFor(token);
        if (price == 0) return 0;
        baseOut = (quoteIn * ONE) / price;
        baseOut = (baseOut * quoteMultiplierBps) / BPS_DENOM;
    }

    /// @dev quoteSell: selling `baseIn` of base → how many of quote.
    ///      quote = baseIn * price / 1e18 * mult / 10_000.
    function quoteSell(address token, uint256 baseIn) external view returns (uint256 quoteOut) {
        uint256 price = _priceFor(token);
        quoteOut = (baseIn * price) / ONE;
        quoteOut = (quoteOut * quoteMultiplierBps) / BPS_DENOM;
    }

    // ── Internal ───────────────────────────────────────────────────────────

    function _priceFor(address token) internal view returns (uint256) {
        uint256 p = priceOf[token];
        if (p != 0) return p;
        return priceOf[address(0)];
    }
}
