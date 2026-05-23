// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { PitchTerminalAccess } from "../src/PitchTerminalAccess.sol";
import { MockContractOwner } from "./mocks/MockContractOwner.sol";
import { MockPitch } from "./mocks/MockPitch.sol";
import { MockReentrantERC20 } from "./mocks/MockReentrantERC20.sol";

/// @notice Unit tests for `PitchTerminalAccess` (Model C — two-sided referral).
///         Mapped to the security requirements from docs/contracts.md §1:
///         - A. CEI + nonReentrant on `buyAccess`
///         - B. SafeERC20 (covered indirectly — `safeTransferFrom` path)
///         - C. Ownable2Step
///         - D. Constructor zero-address / zero-price / split-sum validation
///         - E. Non-payable (no receive/fallback)
///         - F. Standard ERC20 assumption (MockPitch is OZ stock)
///         - G. setPrice bounded by MAX_PRICE
///         - H. setReferralSplit bounded by MAX_TOTAL_REFERRAL_BPS (sum)
///         - I. Rounding invariant: referralAmount + treasuryAmount == buyerPaid
///              (valid referrer) / treasuryAmount == price (invalid referrer)
///         - J. Self-ref / self-contract / zero-address-referrer → silent skip
///              (no revert, no discount applied)
contract PitchTerminalAccessTest is Test {
    PitchTerminalAccess internal access;
    MockPitch internal pitch;

    address internal owner = address(0xA11CE);
    address internal treasury = address(0xBEEF);
    address internal alice = address(0xA);
    address internal bob = address(0xB);
    address internal carol = address(0xC);
    address internal dave = address(0xD);

    uint256 internal constant PRICE = 1e18;
    uint16 internal constant DEFAULT_BUYER_DISCOUNT_BPS = 2500; // 25%
    uint16 internal constant DEFAULT_REFERRAL_BPS = 2500; // 25%

    // Re-declared events for vm.expectEmit comparison.
    event AccessPurchased(
        address indexed user, address indexed referrer, uint256 buyerPaid, uint256 referralAmount
    );
    event AccessGranted(address indexed user);
    event AccessRevoked(address indexed user);
    event PriceChanged(uint256 newPrice);
    event ReferralSplitUpdated(uint16 newBuyerDiscountBps, uint16 newReferralBps);

    function setUp() public {
        pitch = new MockPitch();
        access = new PitchTerminalAccess(
            IERC20(address(pitch)),
            treasury,
            PRICE,
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            owner
        );
        pitch.mint(alice, 100e18);
        pitch.mint(bob, 100e18);
        pitch.mint(carol, 100e18);
    }

    // ---------------------------------------------------------------------
    // Constructor (req D, G, H)
    // ---------------------------------------------------------------------

    function test_Constructor_StoresImmutables() public view {
        assertEq(address(access.PITCH()), address(pitch));
        assertEq(access.TREASURY(), treasury);
        assertEq(access.price(), PRICE);
        assertEq(access.owner(), owner);
        assertEq(access.buyerDiscountBps(), DEFAULT_BUYER_DISCOUNT_BPS);
        assertEq(access.referralBps(), DEFAULT_REFERRAL_BPS);
        assertEq(access.MAX_PRICE(), 100e18);
        assertEq(access.MAX_BATCH(), 100);
        assertEq(access.MAX_TOTAL_REFERRAL_BPS(), 5000);
    }

    function test_Constructor_RevertsOnZeroPitch() public {
        vm.expectRevert(PitchTerminalAccess.ZeroAddress.selector);
        new PitchTerminalAccess(
            IERC20(address(0)),
            treasury,
            PRICE,
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            owner
        );
    }

    function test_Constructor_RevertsOnZeroTreasury() public {
        vm.expectRevert(PitchTerminalAccess.ZeroAddress.selector);
        new PitchTerminalAccess(
            IERC20(address(pitch)),
            address(0),
            PRICE,
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            owner
        );
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        // OZ Ownable rejects zero owner first with its own error.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new PitchTerminalAccess(
            IERC20(address(pitch)),
            treasury,
            PRICE,
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            address(0)
        );
    }

    function test_Constructor_RevertsOnZeroPrice() public {
        vm.expectRevert(PitchTerminalAccess.InvalidPrice.selector);
        new PitchTerminalAccess(
            IERC20(address(pitch)),
            treasury,
            0,
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            owner
        );
    }

    function test_Constructor_RevertsOnPriceAboveMax() public {
        vm.expectRevert(PitchTerminalAccess.InvalidPrice.selector);
        new PitchTerminalAccess(
            IERC20(address(pitch)),
            treasury,
            100e18 + 1,
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            owner
        );
    }

    function test_Constructor_AllowsPriceEqualsMax() public {
        PitchTerminalAccess a = new PitchTerminalAccess(
            IERC20(address(pitch)),
            treasury,
            access.MAX_PRICE(),
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            owner
        );
        assertEq(a.price(), 100e18);
    }

    function test_Constructor_RevertsOnSplitSumAboveMax() public {
        // 2500 + 2501 = 5001 > MAX_TOTAL_REFERRAL_BPS.
        vm.expectRevert(PitchTerminalAccess.InvalidReferralSplit.selector);
        new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 2500, 2501, owner);
    }

    function test_Constructor_RevertsOnEachComponentAboveMaxAlone() public {
        // 5001 alone — also above sum cap.
        vm.expectRevert(PitchTerminalAccess.InvalidReferralSplit.selector);
        new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 5001, 0, owner);

        vm.expectRevert(PitchTerminalAccess.InvalidReferralSplit.selector);
        new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 0, 5001, owner);
    }

    function test_Constructor_AllowsSplitSumEqualsMax() public {
        PitchTerminalAccess a1 =
            new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 2500, 2500, owner);
        assertEq(a1.buyerDiscountBps(), 2500);
        assertEq(a1.referralBps(), 2500);

        PitchTerminalAccess a2 =
            new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 5000, 0, owner);
        assertEq(a2.buyerDiscountBps(), 5000);
        assertEq(a2.referralBps(), 0);

        PitchTerminalAccess a3 =
            new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 0, 5000, owner);
        assertEq(a3.buyerDiscountBps(), 0);
        assertEq(a3.referralBps(), 5000);
    }

    function test_Constructor_AllowsBothZero() public {
        PitchTerminalAccess a =
            new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 0, 0, owner);
        assertEq(a.buyerDiscountBps(), 0);
        assertEq(a.referralBps(), 0);
    }

    // ---------------------------------------------------------------------
    // buyAccess — no-ref / generic paths (req A, B, F, J)
    // ---------------------------------------------------------------------

    function test_BuyAccess_HappyPath_NoReferrer() public {
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 treasuryBefore = pitch.balanceOf(treasury);
        uint256 aliceBefore = pitch.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, address(0), PRICE, 0);

        vm.prank(alice);
        access.buyAccess(address(0));

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
        access.buyAccess(address(0));
    }

    function test_BuyAccess_RevertsWhenAlreadyPaid() public {
        vm.startPrank(alice);
        pitch.approve(address(access), PRICE * 2);
        access.buyAccess(address(0));

        vm.expectRevert(PitchTerminalAccess.AlreadyHasAccess.selector);
        access.buyAccess(address(0));
        vm.stopPrank();
    }

    function test_BuyAccess_RevertsWhenWhitelisted() public {
        vm.prank(owner);
        access.grantAccess(alice);

        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        vm.prank(alice);
        vm.expectRevert(PitchTerminalAccess.AlreadyHasAccess.selector);
        access.buyAccess(address(0));
    }

    /// @dev Reentrancy test (req A): deploy a fresh access bound to a malicious
    ///      ERC20 that re-enters `buyAccess(address(0))` from inside `transferFrom`.
    ///      The `nonReentrant` modifier must cause the inner call to revert, which
    ///      bubbles up and aborts the whole purchase.
    function test_BuyAccess_NonReentrant() public {
        MockReentrantERC20 evil = new MockReentrantERC20();
        PitchTerminalAccess evilAccess = new PitchTerminalAccess(
            IERC20(address(evil)),
            treasury,
            PRICE,
            DEFAULT_BUYER_DISCOUNT_BPS,
            DEFAULT_REFERRAL_BPS,
            owner
        );

        evil.mint(alice, 100e18);
        vm.prank(alice);
        evil.approve(address(evilAccess), PRICE);

        evil.arm(address(evilAccess));

        // The outer call reverts because the inner re-entry hits nonReentrant.
        // It is critical that we expect EXACTLY `ReentrancyGuardReentrantCall.selector`
        // and not `AlreadyHasAccess.selector`: under CEI (`paid[alice] = true` runs
        // before the external transfer) a re-entry on the same `msg.sender` would also
        // fail with `AlreadyHasAccess` if `nonReentrant` were absent. Asserting on the
        // reentrancy-guard selector specifically is what proves the guard is doing the
        // work — any future refactor that silently weakens the modifier would change
        // the revert to `AlreadyHasAccess` and break this test, surfacing the regression.
        vm.prank(alice);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        evilAccess.buyAccess(address(0));

        // State was rolled back — no purchase recorded, no funds moved.
        assertFalse(evilAccess.paid(alice));
        assertFalse(evilAccess.hasAccess(alice));
        assertEq(evil.balanceOf(treasury), 0);
        assertEq(evil.balanceOf(alice), 100e18); // full balance returned (rollback)
    }

    // ---------------------------------------------------------------------
    // buyAccess — two-sided referral path (req I, J)
    // ---------------------------------------------------------------------

    /// @dev Default split = (25%, 25%). buyer pays 0.75, referrer gets 0.25,
    ///      treasury gets 0.50.
    function test_BuyAccess_AppliesBuyerDiscount() public {
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 bobBefore = pitch.balanceOf(bob);
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        uint256 expectedBuyerPaid = (PRICE * (10000 - DEFAULT_BUYER_DISCOUNT_BPS)) / 10000; // 0.75e18
        uint256 expectedRef = (PRICE * DEFAULT_REFERRAL_BPS) / 10000; // 0.25e18
        uint256 expectedTreasury = expectedBuyerPaid - expectedRef; // 0.5e18

        assertEq(expectedBuyerPaid, 0.75e18);
        assertEq(expectedRef, 0.25e18);
        assertEq(expectedTreasury, 0.5e18);

        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, bob, expectedBuyerPaid, expectedRef);

        vm.prank(alice);
        access.buyAccess(bob);

        assertEq(pitch.balanceOf(alice), aliceBefore - expectedBuyerPaid);
        assertEq(pitch.balanceOf(bob), bobBefore + expectedRef);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + expectedTreasury);
        // Contract holds nothing.
        assertEq(pitch.balanceOf(address(access)), 0);
        assertTrue(access.paid(alice));
    }

    /// @dev Split (5000, 0): buyer gets full 50% discount, referrer gets nothing,
    ///      treasury gets exactly the buyer's payment (0.5e18). Event reports
    ///      `referrer = address(0)` because no cashback was paid.
    function test_BuyAccess_OnlyDiscount_NoReferralKickback() public {
        PitchTerminalAccess a =
            new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 5000, 0, owner);

        vm.startPrank(alice);
        pitch.approve(address(a), PRICE);

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 bobBefore = pitch.balanceOf(bob);
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        uint256 expectedBuyerPaid = PRICE / 2; // 0.5e18

        vm.expectEmit(true, true, false, true, address(a));
        emit AccessPurchased(alice, address(0), expectedBuyerPaid, 0);

        a.buyAccess(bob);
        vm.stopPrank();

        assertEq(pitch.balanceOf(alice), aliceBefore - expectedBuyerPaid);
        assertEq(pitch.balanceOf(bob), bobBefore);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + expectedBuyerPaid);
        assertTrue(a.paid(alice));
    }

    /// @dev Split (0, 5000): no buyer discount but referrer receives 50% cashback.
    ///      buyer pays full price, referrer gets 0.5, treasury gets 0.5.
    function test_BuyAccess_OnlyKickback_NoBuyerDiscount() public {
        PitchTerminalAccess a =
            new PitchTerminalAccess(IERC20(address(pitch)), treasury, PRICE, 0, 5000, owner);

        vm.startPrank(alice);
        pitch.approve(address(a), PRICE);

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 bobBefore = pitch.balanceOf(bob);
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        uint256 expectedRef = PRICE / 2; // 0.5e18
        uint256 expectedTreasury = PRICE - expectedRef; // 0.5e18

        vm.expectEmit(true, true, false, true, address(a));
        emit AccessPurchased(alice, bob, PRICE, expectedRef);

        a.buyAccess(bob);
        vm.stopPrank();

        assertEq(pitch.balanceOf(alice), aliceBefore - PRICE);
        assertEq(pitch.balanceOf(bob), bobBefore + expectedRef);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + expectedTreasury);
        assertTrue(a.paid(alice));
    }

    function test_BuyAccess_NoReferral_NoDiscount() public {
        // Default split (25%, 25%): without a valid referrer the buyer pays full
        // price (no discount), treasury gets full price.
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 treasuryBefore = pitch.balanceOf(treasury);
        uint256 aliceBefore = pitch.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, address(0), PRICE, 0);

        vm.prank(alice);
        access.buyAccess(address(0));

        assertEq(pitch.balanceOf(treasury), treasuryBefore + PRICE);
        assertEq(pitch.balanceOf(alice), aliceBefore - PRICE);
    }

    function test_BuyAccess_SelfRef_NoDiscount() public {
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        // Buyer paid the FULL price — no discount applied for self-ref (req J).
        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, address(0), PRICE, 0);

        vm.prank(alice);
        access.buyAccess(alice);

        assertEq(pitch.balanceOf(treasury), treasuryBefore + PRICE);
        assertEq(pitch.balanceOf(alice), aliceBefore - PRICE);
        assertTrue(access.paid(alice));
    }

    function test_BuyAccess_ContractRef_NoDiscount() public {
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 treasuryBefore = pitch.balanceOf(treasury);
        uint256 aliceBefore = pitch.balanceOf(alice);

        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, address(0), PRICE, 0);

        vm.prank(alice);
        access.buyAccess(address(access));

        // Contract holds nothing; treasury got the full price; no discount.
        assertEq(pitch.balanceOf(address(access)), 0);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + PRICE);
        assertEq(pitch.balanceOf(alice), aliceBefore - PRICE);
        assertTrue(access.paid(alice));
    }

    /// @dev Anti-grief: a `?ref=<PITCH token address>` link would otherwise burn the
    ///      referrer share at the PITCH contract (no rescue path). Req J filters this
    ///      out as a silent skip — full payment to treasury, no discount, event reports
    ///      no referrer. The PITCH token's own balance is unchanged (no transferFrom to
    ///      it happens).
    function test_BuyAccess_PitchTokenAsReferrer_TreatedAsNoRef() public {
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 treasuryBefore = pitch.balanceOf(treasury);
        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 pitchSelfBefore = pitch.balanceOf(address(pitch));

        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, address(0), PRICE, 0);

        vm.prank(alice);
        access.buyAccess(address(pitch));

        // PITCH-token balance unchanged (no burn), treasury got full price, no discount.
        assertEq(pitch.balanceOf(address(pitch)), pitchSelfBefore);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + PRICE);
        assertEq(pitch.balanceOf(alice), aliceBefore - PRICE);
        assertTrue(access.paid(alice));
    }

    /// @dev When `referralBps = 0` but `buyerDiscountBps > 0`, supplying a valid
    ///      referrer still produces a discount for the buyer; the referrer simply
    ///      receives nothing and the event reports `referrer = address(0)`.
    function test_BuyAccess_ZeroReferralBps_ButDiscountKept() public {
        // Owner disables cashback only — discount stays at 25%.
        vm.prank(owner);
        access.setReferralSplit(DEFAULT_BUYER_DISCOUNT_BPS, 0);

        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 bobBefore = pitch.balanceOf(bob);
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        uint256 expectedBuyerPaid = (PRICE * (10000 - DEFAULT_BUYER_DISCOUNT_BPS)) / 10000; // 0.75e18

        // Valid referrer but referralBps=0 → event reports no referrer.
        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, address(0), expectedBuyerPaid, 0);

        vm.prank(alice);
        access.buyAccess(bob);

        // Referrer received nothing, treasury received the buyer's payment, buyer
        // paid the discounted amount.
        assertEq(pitch.balanceOf(bob), bobBefore);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + expectedBuyerPaid);
        assertEq(pitch.balanceOf(alice), aliceBefore - expectedBuyerPaid);
        assertTrue(access.paid(alice));
    }

    /// @dev Both bps = 0 (full kill-switch): buyer pays full price even with a valid
    ///      referrer, treasury receives full price, referrer receives nothing.
    function test_BuyAccess_BothZero_FullKillSwitch() public {
        vm.prank(owner);
        access.setReferralSplit(0, 0);

        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 bobBefore = pitch.balanceOf(bob);
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        // buyerDiscountBps=0 → buyerPaid = price; referralBps=0 → cashback leg
        // taken, event reports no referrer.
        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, address(0), PRICE, 0);

        vm.prank(alice);
        access.buyAccess(bob);

        assertEq(pitch.balanceOf(bob), bobBefore);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + PRICE);
    }

    /// @dev Atomicity test: buyer's balance is enough for the referral leg but not
    ///      for the subsequent treasury leg. The second `safeTransferFrom` must
    ///      revert, rolling back the first transfer and the `paid` flag.
    ///      Default split (25%, 25%): referral leg = 0.25e18, treasury leg = 0.5e18.
    ///      Give buyer only 0.4e18 → first transfer succeeds (0.25), second fails.
    function test_BuyAccess_ReferralAtomicity_RevertsIfTreasuryTransferFails() public {
        address poor = address(0xDEAD1);
        pitch.mint(poor, 0.4e18);

        vm.startPrank(poor);
        pitch.approve(address(access), PRICE);
        vm.expectRevert(); // ERC20InsufficientBalance bubbled through SafeERC20
        access.buyAccess(bob);
        vm.stopPrank();

        // Everything rolled back: referrer received nothing, treasury received nothing,
        // buyer still has full 0.4e18, `paid` flag is unset.
        assertEq(pitch.balanceOf(bob), 100e18);
        assertEq(pitch.balanceOf(treasury), 0);
        assertEq(pitch.balanceOf(poor), 0.4e18);
        assertFalse(access.paid(poor));
        assertFalse(access.hasAccess(poor));
    }

    /// @dev Rounding-invariant property (req I): for arbitrary
    ///      `price ∈ (0, MAX_PRICE]` and `(discount, ref)` with
    ///      `discount + ref ≤ MAX_TOTAL_REFERRAL_BPS`:
    ///      - valid referrer → `referralAmount + treasuryAmount == buyerPaid`
    ///        AND `buyerPaid == price * (10000 - discount) / 10000` (no lost wei).
    ///      - invalid referrer (zero / msg.sender / address(contract) /
    ///        address(PITCH)) → `treasuryAmount == price`, no discount.
    function testFuzz_RoundingInvariant(uint256 _price, uint16 _discount, uint16 _ref) public {
        uint256 boundedPrice = bound(_price, 1, access.MAX_PRICE());
        uint16 maxBps = access.MAX_TOTAL_REFERRAL_BPS();
        // Cap discount at maxBps first, then cap ref at the remainder.
        uint16 boundedDiscount = uint16(bound(uint256(_discount), 0, uint256(maxBps)));
        uint16 boundedRef = uint16(bound(uint256(_ref), 0, uint256(maxBps - boundedDiscount)));

        // Deploy a fresh contract with the fuzzed parameters so the constructor
        // path is also exercised by every fuzz run.
        PitchTerminalAccess a = new PitchTerminalAccess(
            IERC20(address(pitch)), treasury, boundedPrice, boundedDiscount, boundedRef, owner
        );

        // Branch 1: valid referrer.
        {
            address buyer = address(0xB001);
            pitch.mint(buyer, boundedPrice);
            uint256 bobBefore = pitch.balanceOf(bob);
            uint256 treasuryBefore = pitch.balanceOf(treasury);

            vm.startPrank(buyer);
            pitch.approve(address(a), boundedPrice);
            a.buyAccess(bob);
            vm.stopPrank();

            uint256 expectedBuyerPaid = (boundedPrice * (10000 - uint256(boundedDiscount))) / 10000;
            uint256 expectedRef = (boundedPrice * uint256(boundedRef)) / 10000;
            uint256 refDelta = pitch.balanceOf(bob) - bobBefore;
            uint256 treasuryDelta = pitch.balanceOf(treasury) - treasuryBefore;
            uint256 buyerDelta = boundedPrice - pitch.balanceOf(buyer);

            // Buyer paid the discounted amount (exact, floor-div).
            assertEq(buyerDelta, expectedBuyerPaid);
            // Referrer received exactly `price * ref / 10000` (or 0 when ref leg skipped).
            assertEq(refDelta, expectedRef);
            // Sum invariant — treasury collects the remainder of the buyer's payment.
            assertEq(refDelta + treasuryDelta, expectedBuyerPaid);
            // Contract holds nothing.
            assertEq(pitch.balanceOf(address(a)), 0);
        }

        // Branch 2: each invalid-referrer variant collects the full price into
        // treasury, applies no discount, and leaves the contract empty. Iterate
        // through all four silent-skip targets: 0x0, msg.sender, address(this),
        // address(PITCH).
        address[4] memory invalidReferrers = [
            address(0),
            address(0), // placeholder for msg.sender — replaced below
            address(a),
            address(pitch)
        ];
        for (uint256 i = 0; i < invalidReferrers.length; i++) {
            address buyer = address(uint160(0xB100 + i));
            pitch.mint(buyer, boundedPrice);
            uint256 treasuryBefore = pitch.balanceOf(treasury);
            address referrerArg = i == 1 ? buyer : invalidReferrers[i];

            vm.startPrank(buyer);
            pitch.approve(address(a), boundedPrice);
            a.buyAccess(referrerArg);
            vm.stopPrank();

            uint256 treasuryDelta = pitch.balanceOf(treasury) - treasuryBefore;
            assertEq(treasuryDelta, boundedPrice);
            assertEq(pitch.balanceOf(buyer), 0);
            // The silent-skip target itself must never receive funds — even if
            // it's a balance-holding address like PITCH or another contract.
            if (referrerArg != treasury) {
                // (treasury itself is the only address that *should* gain — we
                // already asserted that delta above. Anything else stays put.)
                assertEq(pitch.balanceOf(address(a)), 0);
            }
        }
    }

    /// @dev Sanity check on the event ABI: 4 fields, `user` + `referrer` indexed,
    ///      `buyerPaid` + `referralAmount` non-indexed. expectEmit with
    ///      `checkTopic1=true, checkTopic2=true, checkTopic3=false,
    ///      checkData=true` enforces this.
    function test_AccessPurchased_EventShape() public {
        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 expectedBuyerPaid = (PRICE * (10000 - DEFAULT_BUYER_DISCOUNT_BPS)) / 10000;
        uint256 expectedRef = (PRICE * DEFAULT_REFERRAL_BPS) / 10000;
        vm.expectEmit(true, true, false, true, address(access));
        emit AccessPurchased(alice, bob, expectedBuyerPaid, expectedRef);

        vm.prank(alice);
        access.buyAccess(bob);
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
        access.buyAccess(address(0));
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
        access.buyAccess(address(0));
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

    /// @dev Symmetry with `grantAccess` / `grantBatch`: revoking `address(0)` must
    ///      revert with `ZeroAddress` to prevent log pollution.
    function test_RevokeAccess_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.ZeroAddress.selector);
        access.revokeAccess(address(0));
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
        access.buyAccess(address(0));
        vm.stopPrank();

        // Treasury received the new price, not the old one.
        assertEq(pitch.balanceOf(treasury), 3e18);
    }

    // ---------------------------------------------------------------------
    // Owner ops — setReferralSplit (req H)
    // ---------------------------------------------------------------------

    function test_SetReferralSplit_HappyPath() public {
        vm.expectEmit(false, false, false, true, address(access));
        emit ReferralSplitUpdated(1000, 4000);

        vm.prank(owner);
        access.setReferralSplit(1000, 4000);

        assertEq(access.buyerDiscountBps(), 1000);
        assertEq(access.referralBps(), 4000);
    }

    function test_SetReferralSplit_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        access.setReferralSplit(1000, 1000);
    }

    function test_SetReferralSplit_RevertsOnSumAboveMax() public {
        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.InvalidReferralSplit.selector);
        access.setReferralSplit(2500, 2501);

        // Individual components above the cap also revert (sum check covers both).
        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.InvalidReferralSplit.selector);
        access.setReferralSplit(5001, 0);

        vm.prank(owner);
        vm.expectRevert(PitchTerminalAccess.InvalidReferralSplit.selector);
        access.setReferralSplit(0, 5001);
    }

    function test_SetReferralSplit_AllowsZeroZero() public {
        vm.expectEmit(false, false, false, true, address(access));
        emit ReferralSplitUpdated(0, 0);

        vm.prank(owner);
        access.setReferralSplit(0, 0);

        assertEq(access.buyerDiscountBps(), 0);
        assertEq(access.referralBps(), 0);
    }

    function test_SetReferralSplit_AllowsMaxSum() public {
        vm.startPrank(owner);

        access.setReferralSplit(2500, 2500);
        assertEq(access.buyerDiscountBps(), 2500);
        assertEq(access.referralBps(), 2500);

        access.setReferralSplit(5000, 0);
        assertEq(access.buyerDiscountBps(), 5000);
        assertEq(access.referralBps(), 0);

        access.setReferralSplit(0, 5000);
        assertEq(access.buyerDiscountBps(), 0);
        assertEq(access.referralBps(), 5000);

        vm.stopPrank();
    }

    /// @dev Atomic rebalance: (1000, 4000) → (4000, 1000) in a single call.
    ///      Separate setters would have temporarily violated the sum cap mid-call;
    ///      the combined setter does not.
    function test_SetReferralSplit_AtomicRebalance() public {
        vm.startPrank(owner);
        access.setReferralSplit(1000, 4000);
        assertEq(access.buyerDiscountBps(), 1000);
        assertEq(access.referralBps(), 4000);

        access.setReferralSplit(4000, 1000);
        assertEq(access.buyerDiscountBps(), 4000);
        assertEq(access.referralBps(), 1000);
        vm.stopPrank();
    }

    function test_SetReferralSplit_AffectsSubsequentBuys() public {
        // Switch from (2500, 2500) to (1000, 4000). New purchase uses new numbers:
        // buyerPaid = 0.9e18, ref = 0.4e18, treasury = 0.5e18.
        vm.prank(owner);
        access.setReferralSplit(1000, 4000);

        vm.prank(alice);
        pitch.approve(address(access), PRICE);

        uint256 aliceBefore = pitch.balanceOf(alice);
        uint256 bobBefore = pitch.balanceOf(bob);
        uint256 treasuryBefore = pitch.balanceOf(treasury);

        vm.prank(alice);
        access.buyAccess(bob);

        uint256 expectedBuyerPaid = (PRICE * (10000 - 1000)) / 10000; // 0.9e18
        uint256 expectedRef = (PRICE * 4000) / 10000; // 0.4e18
        uint256 expectedTreasury = expectedBuyerPaid - expectedRef; // 0.5e18

        assertEq(pitch.balanceOf(alice), aliceBefore - expectedBuyerPaid);
        assertEq(pitch.balanceOf(bob), bobBefore + expectedRef);
        assertEq(pitch.balanceOf(treasury), treasuryBefore + expectedTreasury);
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

    /// @dev Production owner will typically be a Safe multisig — a *contract*
    ///      with code, not an EOA. Verify that the Ownable2Step accept-flow
    ///      works when the pending owner is itself a contract calling
    ///      ``acceptOwnership`` through its own ``call`` path.
    function test_Ownership_AcceptByContract() public {
        MockContractOwner contractOwner = new MockContractOwner();

        // Transfer ownership from the EOA owner to the contract.
        vm.prank(owner);
        access.transferOwnership(address(contractOwner));

        // The EOA owner is still active until acceptance.
        assertEq(access.owner(), owner);
        assertEq(access.pendingOwner(), address(contractOwner));

        // The contract accepts ownership via its forwarder.
        contractOwner.call(
            address(access),
            abi.encodeWithSelector(access.acceptOwnership.selector)
        );

        assertEq(access.owner(), address(contractOwner));
        assertEq(access.pendingOwner(), address(0));

        // Sanity: the contract can now exercise owner-only powers.
        contractOwner.call(
            address(access),
            abi.encodeWithSelector(access.setPrice.selector, 2e18)
        );
        assertEq(access.price(), 2e18);
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
        access.buyAccess(address(0));
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
        access.buyAccess(address(0));
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
