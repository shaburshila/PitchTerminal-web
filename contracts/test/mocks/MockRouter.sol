// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IHook } from "../../src/interfaces/IHook.sol";
import { IRouter } from "../../src/interfaces/IRouter.sol";

/// @notice Minimal ERC20 surface needed for the mock router to mint/burn the
///         traded token. Implemented by `MockPitch` (mint) and any test token
///         that exposes a public `mint` / `burn` pair.
interface IMintableERC20 is IERC20 {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

/// @notice Test double for the pitchwc Router. Implements buy/sell against a
///         simulated bonding curve sourced from a `MockHook`. For `buy`,
///         pulls quote in from `msg.sender` and mints base out; for `sell`,
///         burns base from `msg.sender` and pushes quote out. The router
///         itself custodies the quote-token reserve (seeded by the test).
/// @dev Not reentrancy-safe (mock). Reverts with `RouterSlippage()` when the
///      hook-derived amountOut is below the caller's `minOut` — this mirrors
///      pitchwc's revert path for the slippage test cases in C2.3.
contract MockRouter is IRouter {
    using SafeERC20 for IERC20;

    IHook public immutable HOOK;
    IERC20 public immutable PITCH;

    /// @notice Emitted on every successful swap so tests can assert
    ///         token movement directionality without re-deriving balances.
    event MockSwap(
        uint8 side, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut
    );

    /// @notice For player venue swaps the quote token is the country token —
    ///         the test points this at the correct `MockPitch` instance for
    ///         the relevant venue (set before each call via `setQuoteToken`).
    /// @dev Defaults to PITCH (country venue). Switch per-test for player.
    address public quoteToken;

    error RouterSlippage();
    error UnknownVenue();

    constructor(IERC20 pitch, IHook hook) {
        PITCH = pitch;
        HOOK = hook;
        quoteToken = address(pitch);
    }

    /// @notice Test-only: override quote token (e.g. to a country-token mock
    ///         for player venue scenarios).
    function setQuoteToken(address token) external {
        quoteToken = token;
    }

    function buy(address token, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        amountOut = HOOK.quoteBuy(token, amountIn);
        if (amountOut < minOut) revert RouterSlippage();

        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), amountIn);
        IMintableERC20(token).mint(msg.sender, amountOut);

        emit MockSwap(0, quoteToken, token, amountIn, amountOut);
    }

    function sell(address token, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut)
    {
        amountOut = HOOK.quoteSell(token, amountIn);
        if (amountOut < minOut) revert RouterSlippage();

        IMintableERC20(token).burn(msg.sender, amountIn);
        IERC20(quoteToken).safeTransfer(msg.sender, amountOut);

        emit MockSwap(1, token, quoteToken, amountIn, amountOut);
    }
}
