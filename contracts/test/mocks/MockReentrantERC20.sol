// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IReentrancyTarget {
    function buyAccess(address referrer) external;
}

/// @notice Malicious ERC20 that re-enters its configured `target.buyAccess()` during
///         `transferFrom`. Used to verify that `PitchTerminalAccess.buyAccess()`
///         is protected by `nonReentrant` (req A).
contract MockReentrantERC20 is ERC20 {
    address public target;
    bool public attackArmed;

    constructor() ERC20("Reentrant", "rPITCH") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_) external {
        target = target_;
        attackArmed = true;
    }

    /// @dev Standard ERC20 transferFrom + re-entry hook. We override the public
    ///      `transferFrom` so OZ's `_spendAllowance` + `_transfer` still happen.
    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (attackArmed && target != address(0)) {
            // Disarm to avoid an infinite loop in the reverted call frame.
            attackArmed = false;
            IReentrancyTarget(target).buyAccess(address(0));
        }
        return super.transferFrom(from, to, value);
    }
}
