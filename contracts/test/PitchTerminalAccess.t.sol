// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { PitchTerminalAccess } from "../src/PitchTerminalAccess.sol";
import { MockPitch } from "./mocks/MockPitch.sol";
import { MockReentrantERC20 } from "./mocks/MockReentrantERC20.sol";

/// @notice Unit tests for `PitchTerminalAccess`. Mapped to the security requirements
///         from docs/contracts.md §1:
///         - A. CEI + nonReentrant on `buyAccess`
///         - B. SafeERC20 (covered indirectly — `safeTransferFrom` path)
///         - C. Ownable2Step
///         - D. Constructor zero-address / zero-price validation
///         - E. Non-payable (no receive/fallback)
///         - F. Standard ERC20 assumption (MockPitch is OZ stock)
///         - G. setPrice bounded by MAX_PRICE
contract PitchTerminalAccessTest is Test {
    PitchTerminalAccess internal access;
    MockPitch internal pitch;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal alice = address(0xA);
    address internal bob = address(0xB);
    address internal carol = address(0xC);

    uint256 internal constant PRICE = 1e18;

    // Re-declared events for vm.expectEmit comparison.
    event AccessPurchased(address indexed user);
    event AccessGranted(address indexed user);
    event AccessRevoked(address indexed user);
    event PriceChanged(uint256 newPrice);

    function setUp() public {
        pitch = new MockPitch();
        access = new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, owner);
        pitch.mint(alice, 100e18);
        pitch.mint(bob, 100e18);
        pitch.mint(carol, 100e18);
    }

    // ---------------------------------------------------------------------
    // Constructor (req D, G)
    // ---------------------------------------------------------------------

    function test_Constructor_StoresImmutables() public view {
        assertEq(address(access.PITCH()), address(pitch));
        assertEq(access.TREASURY(), treasury);
        assertEq(access.price(), PRICE);
        assertEq(access.owner(), owner);
        assertEq(access.MAX_PRICE(), 100e18);
        assertEq(access.MAX_BATCH(), 100);
    }

    function test_Constructor_RevertsOnZeroPitch() public {
        vm.expectRevert(PitchTerminalAccess.ZeroAddress.selector);
        new PitchTerminalAccess(IERC20(address(0)), treasury, PRICE, owner);
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(PitchTerminalAccess.ZeroAddress.selector);
        new PitchTerminalAccess(IERC20(address(pitch)), address(0), PRICE, owner);
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        // OZ Ownable rejects zero owner first with its own error.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, address(0));
    }

    function test_Constructor_RevertsOnZeroPrice() public {
        vm.expectRevert(PitchTerminalAccess.InvalidPrice.selector);
        new PitchTerminalAccess(IERC20(address(pitch)), treasury, 0, owner);
    }

    function test_Constructor_RevertsOnPriceAboveMax() public {
        vm.expectRevert(PitchTerminalAccess.InvalidPrice.selector);
        new PitchTerminalAccess(IERC20(address(pitch)), treasury, 100e18 + 1, owner);
    }

    function test_Constructor_AllowsPriceEqualsMax() public {
        PitchTerminalAccess a =
            new PitchTerminalAccess(IERC20(address(pitch)), treasury, access.MAX_PRICE(), owner);
        assertEq(a.price(), 100e18);
    }

    // ---------------------------------------------------------------------
    // buyAccess (req A, B, F)
    // ---------------------------------------------------------------------

    function test_BuyAccess_HappyPath() public {
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 treasuryBefore = pitch.balanceOf(treasury);
        uint256 aliceBefore = pitch.balanceOf(alice);

        vm.expectEmit(true, false, false, true, address(access));
        emit AccessPurchased(alice);

        vm.prank(alice);
        access.buyAccess();

        assertTrue(access.paid(alice));
        assertFalse(access.whitelisted(alice));
        assertTrue(access.hasAccess(alice));
        assertEq(pitch.balanceOf(treasury), treasuryBefore + PRICE);
        assertEq(pitch.balanceOf(alice), aliceBefore - PRICE);
    }

    function test_BuyAccess_RevertsWithoutApprove() public {
        // No approve — SafeERC20 wraps the ERC20InsufficientAllowance revert.
        vm.prank(alice);
        vm.expectRevert();
        access.buyAccess();
    }

    function test_BuyAccess_RevertsWhenAlreadyPaid() public {
        vm.startPrank(alice);
        pitch.approve(address(access), PRICE * 2);
        access.buyAccess();

        vm.expectRevert(PitchTerminalAccess.AlreadyHasAccess.selector);
        access.buyAccess();
        vm.stopPrank();
    }

    function test_BuyAccess_RevertsWhenWhitelisted() public {
        vm.prank(owner);
        access.grantAccess(alice);

        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        vm.prank(alice);
        vm.expectRevert(PitchTerminalAccess.AlreadyHasAccess.selector);
        access.buyAccess();
    }

    /// @dev Reentrancy test (req A): deploy a fresh access bound to a malicious
    ///      ERC20 that re-enters `buyAccess()` from inside `transferFrom`. The
    ///      `nonReentrant` modifier must cause the inner call to revert, which
    ///      bubbles up and aborts the whole purchase.
    function test_BuyAccess_NonReentrant() public {
        MockReentrantERC20 evil = new MockReentrantERC20();
        PitchTerminalAccess evilAccess =
            new PitchTerminalAccess(IERC20(address(evil)), treasury, PRICE, owner);

        evil.mint(alice, 100e18);
        vm.prank(alice);
        evil.approve(address(evilAccess), PRICE);

        evil.arm(address(evilAccess));

        // The outer call reverts because the inner re-entry hits nonReentrant.
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evilAccess.buyAccess();

        // State was rolled back — no purchase recorded, no funds moved.
        assertFalse(evilAccess.paid(alice));
        assertFalse(evilAccess.hasAccess(alice));
        assertEq(evil.balanceOf(treasury), 0);
    }

    // ---------------------------------------------------------------------
    // hasAccess
    // ---------------------------------------------------------------------

    function test_HasAccess_FalseInitially() public view {
        assertFalse(access.hasAccess(alice));
        assertFalse(access.hasAccess(bob));
    }

    function test_HasAccess_TrueAfterPay() public {
        vm.startPrank(alice);
        pitch.approve(address(access), PRICE);
        access.buyAccess();
        vm.stopPrank();

        assertTrue(access.hasAccess(alice));
        assertTrue(access.paid(alice));
    }

    function test_HasAccess_TrueAfterGrant() public {
        vm.prank(owner);
        access.grantAccess(bob);
        assertTrue(access.hasAccess(bob));
        assertTrue(access.whitelisted(bob));
        assertFalse(access.paid(bob));
    }

    function test_HasAccess_FalseAfterRevoke() public {
        vm.startPrank(owner);
        access.grantAccess(bob);
        assertTrue(access.hasAccess(bob));

        access.revokeAccess(bob);
        vm.stopPrank();

        assertFalse(access.hasAccess(bob));
        assertFalse(access.whitelisted(bob));
    }

    function test_HasAccess_RevokeDoesNotTouchPaid() public {
        // Purchased access is permanent — revokeAccess only affects whitelist.
        vm.startPrank(alice);
        pitch.approve(address(access), PRICE);
        access.buyAccess();
        vm.stopPrank();

        vm.prank(owner);
        access.revokeAccess(alice);

        assertTrue(access.paid(alice));
        assertTrue(access.hasAccess(alice));
    }

    // ---------------------------------------------------------------------
    // Owner ops — grantAccess / grantBatch / revokeAccess / setPrice (req C, G)
    // ---------------------------------------------------------------------

    function test_GrantAccess_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        access.grantAccess(bob);

        vm.expectEmit(true, false, false, true, address(access));
        emit AccessGranted(bob);
        vm.prank(owner);
        access.grantAccess(bob);

        assertTrue(access.whitelisted(bob));
    }

    function test_GrantAccess_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.ZeroAddress.selector);
        access.grantAccess(address(0));
    }

    function test_GrantBatch_HappyPath() public {
        address[] memory addrs = new address[](5);
        addrs[0] = address(0x101);
        addrs[1] = address(0x102);
        addrs[2] = address(0x103);
        addrs[3] = address(0x104);
        addrs[4] = address(0x105);

        vm.prank(owner);
        access.grantBatch(addrs);

        for (uint256 i = 0; i < addrs.length; i++) {
            assertTrue(access.whitelisted(addrs[i]));
            assertTrue(access.hasAccess(addrs[i]));
        }
    }

    function test_GrantBatch_OnlyOwner() public {
        address[] memory addrs = new address[](1);
        addrs[0] = bob;

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        access.grantBatch(addrs);
    }

    function test_GrantBatch_RevertsOnZeroAddressInBatch() public {
        address[] memory addrs = new address[](3);
        addrs[0] = bob;
        addrs[1] = address(0);
        addrs[2] = carol;

        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.ZeroAddress.selector);
        access.grantBatch(addrs);
    }

    function test_GrantBatch_RevertsWhenBatchTooLarge() public {
        address[] memory addrs = new address[](101);
        for (uint256 i = 0; i < 101; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            addrs[i] = address(uint160(i + 1));
        }

        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.BatchTooLarge.selector);
        access.grantBatch(addrs);
    }

    function test_GrantBatch_AllowsMaxBatch() public {
        address[] memory addrs = new address[](100);
        for (uint256 i = 0; i < 100; i++) {
            // forge-lint: disable-next-line(unsafe-typecast)
            addrs[i] = address(uint160(i + 1));
        }

        vm.prank(owner);
        access.grantBatch(addrs);

        assertTrue(access.whitelisted(addrs[0]));
        assertTrue(access.whitelisted(addrs[99]));
    }

    function test_GrantBatch_EmptyArrayIsNoop() public {
        address[] memory addrs = new address[](0);
        vm.prank(owner);
        access.grantBatch(addrs); // Doesn't revert; nothing to do.
    }

    function test_RevokeAccess_OnlyOwner() public {
        vm.prank(owner);
        access.grantAccess(bob);

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        access.revokeAccess(bob);

        vm.expectEmit(true, false, false, true, address(access));
        emit AccessRevoked(bob);
        vm.prank(owner);
        access.revokeAccess(bob);

        assertFalse(access.whitelisted(bob));
    }

    function test_SetPrice_HappyPath() public {
        vm.expectEmit(false, false, false, true, address(access));
        emit PriceChanged(2e18);

        vm.prank(owner);
        access.setPrice(2e18);

        assertEq(access.price(), 2e18);
    }

    function test_SetPrice_RevertsOnZero() public {
        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.InvalidPrice.selector);
        access.setPrice(0);
    }

    function test_SetPrice_RevertsAboveMax() public {
        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.InvalidPrice.selector);
        access.setPrice(100e18 + 1);
    }

    function test_SetPrice_AllowsExactlyMax() public {
        vm.prank(owner);
        access.setPrice(100e18);
        assertEq(access.price(), 100e18);
    }

    function test_SetPrice_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        access.setPrice(2e18);
    }

    function test_SetPrice_AffectsSubsequentBuys() public {
        vm.prank(owner);
        access.setPrice(3e18);

        vm.startPrank(alice);
        pitch.approve(address(access), 3e18);
        access.buyAccess();
        vm.stopPrank();

        // Treasury received the new price, not the old one.
        assertEq(pitch.balanceOf(treasury), 3e18);
    }

    // ---------------------------------------------------------------------
    // Ownable2Step (req C)
    // ---------------------------------------------------------------------

    function test_Ownership_TwoStep() public {
        // Step 1: current owner nominates new owner.
        vm.prank(owner);
        access.transferOwnership(bob);

        // Until bob accepts, ownership is still with `owner`.
        assertEq(access.owner(), owner);
        assertEq(access.pendingOwner(), bob);

        // Old owner retains rights pre-acceptance.
        vm.prank(owner);
        access.grantAccess(alice); // doesn't revert
        assertTrue(access.whitelisted(alice));

        // Non-pending account can't accept.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, carol));
        vm.prank(carol);
        access.acceptOwnership();

        // Step 2: pending owner accepts.
        vm.prank(bob);
        access.acceptOwnership();

        assertEq(access.owner(), bob);
        assertEq(access.pendingOwner(), address(0));

        // Old owner has lost rights.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        access.grantAccess(carol);

        // New owner has rights.
        vm.prank(bob);
        access.grantAccess(carol);
        assertTrue(access.whitelisted(carol));
    }

    function test_Ownership_NonOwnerCantTransfer() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        access.transferOwnership(bob);
    }

    // ---------------------------------------------------------------------
    // Misc / req E (no receive/fallback) and req F sanity
    // ---------------------------------------------------------------------

    function test_NotPayable_RejectsEth() public {
        // No receive() / fallback() — sending ETH must revert.
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(access).call{ value: 1 wei }("");
        assertFalse(ok);
    }

    function test_TreasuryReceivesPayment() public {
        assertEq(pitch.balanceOf(treasury), 0);

        vm.startPrank(alice);
        pitch.approve(address(access), PRICE);
        access.buyAccess();
        vm.stopPrank();

        assertEq(pitch.balanceOf(treasury), PRICE);
    }

    function test_PitchAndTreasuryImmutable() public view {
        // The public getters return what was passed at construction.
        // (`immutable` already prevents reassignment at the compiler level.)
        assertEq(address(access.PITCH()), address(pitch));
        assertEq(access.TREASURY(), treasury);
    }

    function test_MultipleUsersIndependent() public {
        vm.startPrank(alice);
        pitch.approve(address(access), PRICE);
        access.buyAccess();
        vm.stopPrank();

        vm.prank(owner);
        access.grantAccess(bob);

        // carol has neither
        assertTrue(access.hasAccess(alice));
        assertTrue(access.hasAccess(bob));
        assertFalse(access.hasAccess(carol));

        // Revoke bob's whitelist → only bob is affected.
        vm.prank(owner);
        access.revokeAccess(bob);
        assertTrue(access.hasAccess(alice));
        assertFalse(access.hasAccess(bob));
    }
}
