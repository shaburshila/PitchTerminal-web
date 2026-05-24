// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IHook — pitchwc bonding-curve hook interface (player and country).
/// @notice Mirrors the on-chain pitchwc Hook surface used by
///         `LimitOrderExecutor` (price read) and by the frontend trade panel
///         (live quotes). Signatures match `docs/eip712.md` §4 and the
///         `currentPrice(address)` selector exercised in
///         `backend/worker/price_loop.py`.
/// @dev All amounts and prices use 18-decimal fixed-point. `currentPrice` is
///      fee-excluded (the chart price); `quoteBuy`/`quoteSell` include the
///      pitchwc 5% protocol fee.
interface IHook {
    /// @notice Current mid price of `token` in quote-wei per 1 whole base.
    ///         For player tokens quote = country token; for country tokens
    ///         quote = PITCH. See `docs/eip712.md` §1.
    function currentPrice(address token) external view returns (uint256);

    /// @notice Quote: spending `quoteIn` wei of the quote token yields how
    ///         many wei of `token` (fee-inclusive).
    function quoteBuy(address token, uint256 quoteIn) external view returns (uint256 baseOut);

    /// @notice Quote: selling `baseIn` wei of `token` yields how many wei of
    ///         the quote token (fee-inclusive).
    function quoteSell(address token, uint256 baseIn) external view returns (uint256 quoteOut);
}
