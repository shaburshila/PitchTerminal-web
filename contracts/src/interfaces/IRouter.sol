// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRouter — pitchwc swap router interface (player and country).
/// @notice Mirrors the pitchwc Router surface invoked by `LimitOrderExecutor`
///         in the swap step. Signatures match `docs/eip712.md` §6 reference
///         flow and the inline ABI in `frontend/src/trade-panel.js`
///         (`buy(address,uint256,uint256)` / `sell(address,uint256,uint256)`).
/// @dev The router pulls the input token from `msg.sender` via
///      `transferFrom` and pushes the output token back to `msg.sender`.
///      For player venue the input on `buy` is the country token of `token`;
///      for country venue the input on `buy` is PITCH.
interface IRouter {
    /// @notice Buy `token` by spending `amountIn` wei of the appropriate
    ///         quote token. Reverts if the realised out is below `minOut`.
    /// @return amountOut wei of `token` received by `msg.sender`.
    function buy(address token, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);

    /// @notice Sell `amountIn` wei of `token` for the appropriate quote
    ///         token. Reverts if the realised out is below `minOut`.
    /// @return amountOut wei of quote token received by `msg.sender`.
    function sell(address token, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);
}
