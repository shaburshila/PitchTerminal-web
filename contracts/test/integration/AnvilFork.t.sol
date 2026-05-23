// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { PitchTerminalAccess } from "../../src/PitchTerminalAccess.sol";

/// @title AnvilForkTest
/// @notice Optional integration smoke against a Base mainnet fork. Exercises the
///         full purchase flow with the **real** PITCH ERC20 — no mocks. Skipped
///         by default so CI does not need an RPC endpoint; opt in by setting
///         `FORK_RPC_URL` (e.g. to `$RPC_URL_BASE_MAINNET`).
///
///         Run locally before C0.5:
///             FORK_RPC_URL=$RPC_URL_BASE_MAINNET \
///                 forge test --match-path test/integration/AnvilFork.t.sol -vv
///
///         The fork uses `deal()` to top up test accounts with PITCH directly
///         (rewriting balance storage slots), so no real holder is exposed.
contract AnvilForkTest is Test {
    /// @notice Real PITCH ERC20 on Base mainnet (see docs/contracts.md / .env.example).
    address internal constant PITCH_MAINNET = 0xeaE13ea73BEc936664A51734c8c01ec7c3B0699C;

    /// @notice Reasonable starting balance for fork-test buyers (10 PITCH).
    uint256 internal constant BUYER_BALANCE = 10e18;

    /// @notice Standard price used in this test (1 PITCH).
    uint256 internal constant PRICE = 1e18;

    PitchTerminalAccess internal access;
    IERC20 internal pitch;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    function setUp() public {
        // Skip the entire suite when FORK_RPC_URL is not set — keeps CI green.
        if (!vm.envExists("FORK_RPC_URL")) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(vm.envString("FORK_RPC_URL"));

        pitch = IERC20(PITCH_MAINNET);

        // Deploy Access with the default 25%/25% split (mirrors mainnet config).
        vm.prank(owner);
        access = new PitchTerminalAccess(pitch, treasury, PRICE, 2500, 2500, owner);

        // Top up buyers — `deal(token, account, amount)` rewrites the relevant
        // storage slot directly, so the test never depends on a real holder.
        deal(address(pitch), alice, BUYER_BALANCE);
        deal(address(pitch), bob, BUYER_BALANCE);
        deal(address(pitch), carol, BUYER_BALANCE);
    }

    /// @dev Full-price purchase (no referrer) — treasury receives `price`.
    function test_Fork_BuyAccess_NoReferrer() public {
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        vm.startPrank(alice);
        pitch.approve(address(access), PRICE);
        access.buyAccess(address(0));
        vm.stopPrank();

        assertTrue(access.paid(alice), "alice.paid");
        assertTrue(access.hasAccess(alice), "alice.hasAccess");
        assertEq(pitch.balanceOf(treasury) - treasuryBefore, PRICE, "treasury received price");
        assertEq(pitch.balanceOf(alice), BUYER_BALANCE - PRICE, "alice paid price");
    }

    /// @dev Referred purchase — buyer pays 75%, referrer gets 25%, treasury gets 50%.
    function test_Fork_BuyAccess_WithReferrer() public {
        // alice is set up as a paid referrer first (so the second buy has a real
        // referrer pre-existing on-chain).
        vm.startPrank(alice);
        pitch.approve(address(access), PRICE);
        access.buyAccess(address(0));
        vm.stopPrank();

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 treasuryBefore = pitch.balanceOf(treasury);
        uint256 bobBefore = pitch.balanceOf(bob);

        uint256 buyerPaid = (PRICE * (10_000 - 2500)) / 10_000; // 0.75 PITCH
        uint256 referralAmount = (PRICE * 2500) / 10_000; // 0.25 PITCH
        uint256 treasuryAmount = buyerPaid - referralAmount; // 0.50 PITCH

        vm.startPrank(bob);
        pitch.approve(address(access), buyerPaid);
        access.buyAccess(alice);
        vm.stopPrank();

        assertTrue(access.paid(bob), "bob.paid");
        assertEq(pitch.balanceOf(bob), bobBefore - buyerPaid, "bob paid 75%");
        assertEq(pitch.balanceOf(alice) - aliceBefore, referralAmount, "alice got 25%");
        assertEq(pitch.balanceOf(treasury) - treasuryBefore, treasuryAmount, "treasury got 50%");
    }

    /// @dev Owner reshuffles the split and the next purchase uses the new ratios.
    function test_Fork_SetReferralSplit_AppliesToNextPurchase() public {
        // Establish alice as a paid referrer first.
        vm.startPrank(alice);
        pitch.approve(address(access), PRICE);
        access.buyAccess(address(0));
        vm.stopPrank();

        // Owner switches to (10%, 40%) — buyer pays 90%, referrer gets 40%,
        // treasury gets 50%.
        vm.prank(owner);
        access.setReferralSplit(1000, 4000);

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 treasuryBefore = pitch.balanceOf(treasury);
        uint256 carolBefore = pitch.balanceOf(carol);

        uint256 buyerPaid = (PRICE * (10_000 - 1000)) / 10_000; // 0.90
        uint256 referralAmount = (PRICE * 4000) / 10_000; // 0.40
        uint256 treasuryAmount = buyerPaid - referralAmount; // 0.50

        vm.startPrank(carol);
        pitch.approve(address(access), buyerPaid);
        access.buyAccess(alice);
        vm.stopPrank();

        assertEq(pitch.balanceOf(carol), carolBefore - buyerPaid, "carol paid 90%");
        assertEq(pitch.balanceOf(alice) - aliceBefore, referralAmount, "alice got 40%");
        assertEq(pitch.balanceOf(treasury) - treasuryBefore, treasuryAmount, "treasury got 50%");
    }
}
