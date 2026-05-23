// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal ERC20 mock with public mint, used in PitchTerminalAccess tests.
contract MockPitch is ERC20 {
    constructor() ERC20("Mock PITCH", "mPITCH") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
