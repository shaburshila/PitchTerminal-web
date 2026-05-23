// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { PitchTerminalAccess } from "../src/PitchTerminalAccess.sol";

/// @title DeployAccess
/// @notice Foundry deploy script for `PitchTerminalAccess`.
///
/// Required env vars (see docs/conventions.md §9):
///   - PITCH_TOKEN  (address)  — PITCH ERC20 used for payment.
///   - TREASURY     (address)  — immutable recipient of access payments.
///   - OWNER        (address)  — initial Ownable2Step owner.
///   - ACCESS_PRICE (uint256)  — initial price in PITCH wei (must be in (0, 100e18]).
///
/// Optional env vars (with defaults that mirror docs/contracts.md §1):
///   - ACCESS_BUYER_DISCOUNT_BPS (uint16, default 2500 = 25%)
///   - ACCESS_REFERRAL_BPS       (uint16, default 2500 = 25%)
///
/// Usage:
///   - Dry-run (simulate, no broadcast):
///       forge script script/DeployAccess.s.sol --rpc-url $RPC_URL_BASE_MAINNET
///   - Anvil fork (smoke):
///       anvil --fork-url $RPC_URL_BASE_MAINNET --fork-block-number <recent>
///       forge script script/DeployAccess.s.sol \
///           --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender 0x<owner>
///   - Mainnet (Ledger):
///       forge script script/DeployAccess.s.sol \
///           --rpc-url $RPC_URL_BASE_MAINNET --account ledger --sender 0x<OWNER> \
///           --broadcast --verify --etherscan-api-key $BASESCAN_KEY
contract DeployAccess is Script {
    /// @notice Hard-coded mirror of `PitchTerminalAccess.MAX_TOTAL_REFERRAL_BPS`.
    /// @dev    Re-stated here so the script fails fast (before broadcasting an
    ///         RPC `eth_call`) when the env-supplied split is out of range; the
    ///         constructor enforces the same check on-chain (defence in depth).
    uint256 internal constant MAX_TOTAL_REFERRAL_BPS = 5000;

    function run() external returns (PitchTerminalAccess access) {
        // --- 1. Read constructor arguments from env ---------------------------------
        address pitch = vm.envAddress("PITCH_TOKEN");
        address treasury = vm.envAddress("TREASURY");
        address owner = vm.envAddress("OWNER");
        uint256 price = vm.envUint("ACCESS_PRICE");

        uint256 discountRaw = vm.envOr("ACCESS_BUYER_DISCOUNT_BPS", uint256(2500));
        uint256 refRaw = vm.envOr("ACCESS_REFERRAL_BPS", uint256(2500));

        require(discountRaw <= type(uint16).max, "ACCESS_BUYER_DISCOUNT_BPS > uint16");
        require(refRaw <= type(uint16).max, "ACCESS_REFERRAL_BPS > uint16");
        uint16 buyerDiscountBps = uint16(discountRaw);
        uint16 referralBps = uint16(refRaw);

        // Pre-flight invariant check (req H). The constructor reverts on the same
        // condition, but failing here saves a wasted RPC round-trip and gives a
        // clearer error message in the script log.
        require(
            uint256(buyerDiscountBps) + uint256(referralBps) <= MAX_TOTAL_REFERRAL_BPS,
            "buyerDiscount + ref > MAX_TOTAL_REFERRAL_BPS"
        );

        // --- 2. Log the parameters --------------------------------------------------
        console2.log("Deploying PitchTerminalAccess with:");
        console2.log("  pitch token   :", pitch);
        console2.log("  treasury      :", treasury);
        console2.log("  owner         :", owner);
        console2.log("  price (wei)   :", price);
        console2.log("  buyer disc bps:", uint256(buyerDiscountBps));
        console2.log("  referral bps  :", uint256(referralBps));

        // --- 3. Broadcast the deploy -----------------------------------------------
        vm.startBroadcast();
        access = new PitchTerminalAccess(
            IERC20(pitch), treasury, price, buyerDiscountBps, referralBps, owner
        );
        vm.stopBroadcast();

        // --- 4. Post-deploy assertions (paranoid mode) ------------------------------
        // The constructor passes `owner` directly to OpenZeppelin `Ownable`, which
        // sets the initial owner immediately (one-step). `Ownable2Step` only kicks
        // in for *subsequent* transfers, so `access.owner() == owner` right after
        // deploy — no pending owner involved.
        require(address(access).code.length > 0, "deploy: no code at address");
        require(access.owner() == owner, "deploy: owner not set to OWNER");
        require(access.price() == price, "deploy: price mismatch");
        require(access.buyerDiscountBps() == buyerDiscountBps, "deploy: buyerDiscountBps mismatch");
        require(access.referralBps() == referralBps, "deploy: referralBps mismatch");
        require(address(access.PITCH()) == pitch, "deploy: PITCH mismatch");
        require(access.TREASURY() == treasury, "deploy: TREASURY mismatch");

        console2.log("Deployed PitchTerminalAccess at:", address(access));
    }
}
