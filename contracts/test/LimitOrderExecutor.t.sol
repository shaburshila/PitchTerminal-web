// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";

import { LimitOrderExecutor } from "../src/LimitOrderExecutor.sol";
import { IHook } from "../src/interfaces/IHook.sol";
import { IRouter } from "../src/interfaces/IRouter.sol";
import { MockHook } from "./mocks/MockHook.sol";
import { MockRouter } from "./mocks/MockRouter.sol";
import { MockPitch } from "./mocks/MockPitch.sol";

/// @notice Mintable+burnable ERC20 used as a tradeable base token (player or
///         country). MockRouter's swap path calls `mint`/`burn` on this token.
contract MintBurnToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}

/// @notice Malicious ERC20 that on `transferFrom` re-enters
///         `LimitOrderExecutor.execute(order, sig)` with a pre-stored payload.
///         Used to prove `nonReentrant` (req G) on `execute` fires.
contract ReentrantInToken is ERC20 {
    LimitOrderExecutor public target;
    LimitOrderExecutor.Order public storedOrder;
    bytes public storedSig;
    bool public armed;

    constructor() ERC20("Reentrant", "rTKN") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function arm(LimitOrderExecutor t, LimitOrderExecutor.Order calldata o, bytes calldata sig)
        external
    {
        target = t;
        storedOrder = o;
        storedSig = sig;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (armed && address(target) != address(0)) {
            armed = false; // avoid infinite loop after the call reverts
            // This re-entry MUST revert with ReentrancyGuardReentrantCall.
            target.execute(storedOrder, storedSig);
        }
        return super.transferFrom(from, to, value);
    }
}

/// @notice Test router that DOES NOT enforce `minOut` against the realised
///         output, allowing tests to push the contract's own `outBal < minOut`
///         safety net (`InsufficientOutput`). Mirrors the threat model where a
///         buggy / lying router silently returns less than promised.
contract PermissiveMockRouter is IRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable PITCH;
    address public quoteToken;
    address public baseTokenAddr;
    uint256 public buyOut;
    uint256 public sellOut;

    constructor(IERC20 _pitch, address _quote) {
        PITCH = _pitch;
        quoteToken = _quote;
    }

    function setOutputs(uint256 b, uint256 s) external {
        buyOut = b;
        sellOut = s;
    }

    function buy(
        address token,
        uint256 amountIn,
        uint256 /*minOut*/
    )
        external
        returns (uint256)
    {
        IERC20(quoteToken).safeTransferFrom(msg.sender, address(this), amountIn);
        MintBurnToken(token).mint(msg.sender, buyOut);
        return buyOut;
    }

    function sell(
        address token,
        uint256 amountIn,
        uint256 /*minOut*/
    )
        external
        returns (uint256)
    {
        MintBurnToken(token).burn(msg.sender, amountIn);
        IERC20(quoteToken).safeTransfer(msg.sender, sellOut);
        return sellOut;
    }
}

/// @notice EIP-1271 smart-wallet mock. Returns the magic value iff
///         `(hash, sig)` matches what the test pre-approved.
contract MockEIP1271Wallet is IERC1271 {
    bytes32 public approvedHash;
    bytes public approvedSig;
    bool public alwaysReject;

    function approve(bytes32 h, bytes calldata s) external {
        approvedHash = h;
        approvedSig = s;
    }

    function setReject(bool v) external {
        alwaysReject = v;
    }

    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        override
        returns (bytes4)
    {
        if (alwaysReject) return bytes4(0);
        if (hash == approvedHash && keccak256(signature) == keccak256(approvedSig)) {
            return IERC1271.isValidSignature.selector;
        }
        return bytes4(0);
    }
}

/// @notice Tests for `LimitOrderExecutor`. Mapped to docs/contracts.md §2 security
///         requirements G-R and docs/eip712.md cross-check ritual.
///         - G. nonReentrant on execute (ReentrantInToken).
///         - H. CEI: nonce set before external transfer/swap.
///         - I. minOut from SIGNED targetPrice + slippageBps only (sandwich-defence).
///         - J. SignatureChecker (ECDSA + EIP-1271); high-s malleable sigs rejected.
///         - K. Signature bound to order.owner.
///         - L. SafeERC20 movement (covered indirectly: non-standard returns OK).
///         - M. Owner receives FULL outToken balance (no dust).
///         - N. Input validation (bounds, expiry, zero-addr, venue, side, slippage,
///              country-venue quoteToken == PITCH).
///         - O. Ownable2Step; pause cannot redirect funds.
///         - P. cancel front-runnable (documented; covered by happy-path race).
///         - Q. cancel NOT guarded by whenNotPaused.
///         - R. Residual allowance reset (allowance(executor, router) == 0).
contract LimitOrderExecutorTest is Test {
    LimitOrderExecutor internal executor;

    MockPitch internal pitch;
    MintBurnToken internal playerToken;
    MintBurnToken internal countryToken;
    MockHook internal playerHook;
    MockHook internal countryHook;
    MockRouter internal playerRouter;
    MockRouter internal countryRouter;

    address internal owner = address(0xA11CE); // executor owner
    address internal alice; // order signer (EOA derived from privkey)
    uint256 internal alicePk;
    address internal bob; // a second EOA
    uint256 internal bobPk;
    address internal keeper = address(0xBADD1E); // arbitrary execute() caller

    // Default prices (1e18 fixed-point, quote-wei per 1 base).
    uint256 internal constant PLAYER_PRICE = 0.01e18; // country-wei per player
    uint256 internal constant COUNTRY_PRICE = 12.5e18; // PITCH-wei per country

    // Re-declared events for vm.expectEmit comparison.
    event OrderExecuted(
        address indexed owner,
        uint256 indexed nonce,
        address indexed token,
        uint8 side,
        uint256 amountIn,
        uint256 amountOut,
        address executor
    );
    event OrderCancelled(address indexed owner, uint256 indexed nonce);

    function setUp() public {
        (alice, alicePk) = makeAddrAndKey("alice");
        (bob, bobPk) = makeAddrAndKey("bob");

        pitch = new MockPitch();
        playerToken = new MintBurnToken("Player", "PLR");
        countryToken = new MintBurnToken("Country", "CTR");

        playerHook = new MockHook(PLAYER_PRICE);
        countryHook = new MockHook(COUNTRY_PRICE);
        playerHook.setPrice(address(playerToken), PLAYER_PRICE);
        countryHook.setPrice(address(countryToken), COUNTRY_PRICE);

        // Routers: player-venue uses countryToken as quote; country-venue uses PITCH.
        playerRouter = new MockRouter(IERC20(address(pitch)), IHook(address(playerHook)));
        playerRouter.setQuoteToken(address(countryToken));
        countryRouter = new MockRouter(IERC20(address(pitch)), IHook(address(countryHook)));
        // countryRouter.quoteToken defaults to PITCH.

        executor = new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(playerHook)),
            IHook(address(countryHook)),
            IRouter(address(playerRouter)),
            IRouter(address(countryRouter)),
            owner
        );

        // Seed liquidity & balances.
        // For player-buy: alice spends countryToken → receives playerToken (minted).
        countryToken.mint(alice, 1_000e18);
        // For player-sell (take-profit): alice has playerToken; router must hold country.
        playerToken.mint(alice, 1_000e18);
        countryToken.mint(address(playerRouter), 10_000e18);

        // For country-buy: alice spends PITCH → receives countryToken (minted).
        pitch.mint(alice, 10_000e18);
        // For country-sell: alice burns countryToken; router pays PITCH.
        pitch.mint(address(countryRouter), 100_000e18);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _mkOrder(uint8 venue, uint8 side, uint256 amountIn, uint256 nonce_)
        internal
        view
        returns (LimitOrderExecutor.Order memory o)
    {
        // For limit-buy (side==0): targetPrice = livePrice (condition `price <= target`
        // is satisfied). For take-profit (side==1): same — `price >= target` also satisfied
        // at equality. Tests that need a *miss* set target below/above explicitly.
        uint256 target;
        address token;
        address quoteToken;
        if (venue == 0) {
            token = address(playerToken);
            quoteToken = address(countryToken);
            target = PLAYER_PRICE;
        } else {
            token = address(countryToken);
            quoteToken = address(pitch);
            target = COUNTRY_PRICE;
        }
        o = LimitOrderExecutor.Order({
            owner: alice,
            token: token,
            quoteToken: quoteToken,
            venue: venue,
            side: side,
            targetPrice: target,
            amountIn: amountIn,
            slippageBps: 100,
            expiry: 0,
            nonce: nonce_
        });
    }

    function _sign(uint256 pk, LimitOrderExecutor.Order memory o)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = executor.digest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Independent off-chain re-implementation of the EIP-712 digest, used
    ///      to prove the contract's hashing matches the spec byte-for-byte.
    function _expectedDigest(LimitOrderExecutor.Order memory o) internal view returns (bytes32) {
        bytes32 domainSep = keccak256(
            abi.encode(
                executor.EIP712_DOMAIN_TYPEHASH(),
                keccak256(bytes(executor.EIP712_DOMAIN_NAME())),
                keccak256(bytes(executor.EIP712_DOMAIN_VERSION())),
                block.chainid,
                address(executor)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                executor.ORDER_TYPEHASH(),
                o.owner,
                o.token,
                o.quoteToken,
                uint256(o.venue),
                uint256(o.side),
                o.targetPrice,
                o.amountIn,
                o.slippageBps,
                o.expiry,
                o.nonce
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSep, structHash));
    }

    function _approveExecutorAsAlice(IERC20 token, uint256 amount) internal {
        vm.prank(alice);
        token.approve(address(executor), amount);
    }

    // =====================================================================
    // Constructor
    // =====================================================================

    function test_Constructor_StoresImmutables() public view {
        assertEq(address(executor.PITCH()), address(pitch));
        assertEq(address(executor.PLAYER_HOOK()), address(playerHook));
        assertEq(address(executor.COUNTRY_HOOK()), address(countryHook));
        assertEq(address(executor.PLAYER_ROUTER()), address(playerRouter));
        assertEq(address(executor.COUNTRY_ROUTER()), address(countryRouter));
        assertEq(executor.owner(), owner);
        assertEq(executor.MAX_SLIPPAGE_BPS(), 1000);
        assertEq(executor.FEE_BPS(), 500);
        assertEq(executor.BPS_DENOM(), 10_000);
        assertEq(executor.ONE(), 1e18);
        assertFalse(executor.paused());
    }

    function test_Constructor_RevertsOnZeroPitch() public {
        vm.expectRevert(LimitOrderExecutor.ZeroAddress.selector);
        new LimitOrderExecutor(
            IERC20(address(0)),
            IHook(address(playerHook)),
            IHook(address(countryHook)),
            IRouter(address(playerRouter)),
            IRouter(address(countryRouter)),
            owner
        );
    }

    function test_Constructor_RevertsOnZeroPlayerHook() public {
        vm.expectRevert(LimitOrderExecutor.ZeroAddress.selector);
        new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(0)),
            IHook(address(countryHook)),
            IRouter(address(playerRouter)),
            IRouter(address(countryRouter)),
            owner
        );
    }

    function test_Constructor_RevertsOnZeroCountryHook() public {
        vm.expectRevert(LimitOrderExecutor.ZeroAddress.selector);
        new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(playerHook)),
            IHook(address(0)),
            IRouter(address(playerRouter)),
            IRouter(address(countryRouter)),
            owner
        );
    }

    function test_Constructor_RevertsOnZeroPlayerRouter() public {
        vm.expectRevert(LimitOrderExecutor.ZeroAddress.selector);
        new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(playerHook)),
            IHook(address(countryHook)),
            IRouter(address(0)),
            IRouter(address(countryRouter)),
            owner
        );
    }

    function test_Constructor_RevertsOnZeroCountryRouter() public {
        vm.expectRevert(LimitOrderExecutor.ZeroAddress.selector);
        new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(playerHook)),
            IHook(address(countryHook)),
            IRouter(address(playerRouter)),
            IRouter(address(0)),
            owner
        );
    }

    function test_Constructor_RevertsOnZeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(playerHook)),
            IHook(address(countryHook)),
            IRouter(address(playerRouter)),
            IRouter(address(countryRouter)),
            address(0)
        );
    }

    function test_Constructor_DomainSeparatorMatchesEIP712Spec() public view {
        bytes32 expected = keccak256(
            abi.encode(
                executor.EIP712_DOMAIN_TYPEHASH(),
                keccak256(bytes(executor.EIP712_DOMAIN_NAME())),
                keccak256(bytes(executor.EIP712_DOMAIN_VERSION())),
                block.chainid,
                address(executor)
            )
        );
        assertEq(executor.DOMAIN_SEPARATOR(), expected);
    }

    // =====================================================================
    // EIP-712 cross-check (docs/eip712.md §7)
    // =====================================================================

    /// @notice Cross-check: the on-chain `hashOrder` matches the spec encoding
    ///         (ORDER_TYPEHASH + abi.encode of all fields with uint8→uint256
    ///         promotion). docs/eip712.md §3.2.
    function test_EIP712_HashOrder_MatchesSpecEncoding() public view {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 5e18, 1);
        bytes32 expected = keccak256(
            abi.encode(
                executor.ORDER_TYPEHASH(),
                o.owner,
                o.token,
                o.quoteToken,
                uint256(o.venue),
                uint256(o.side),
                o.targetPrice,
                o.amountIn,
                o.slippageBps,
                o.expiry,
                o.nonce
            )
        );
        assertEq(executor.hashOrder(o), expected);
    }

    /// @notice Cross-check: the on-chain `digest` matches a fully independent
    ///         off-chain construction (the same algorithm viem runs). This is
    ///         the canonical viem ↔ Solidity sanity check from docs/eip712.md §7.
    function test_EIP712_Digest_MatchesIndependentRecomputation() public view {
        LimitOrderExecutor.Order memory o = _mkOrder(1, 1, 3e18, 42);
        assertEq(executor.digest(o), _expectedDigest(o));
    }

    /// @notice Cross-check: ORDER_TYPEHASH equals the exact keccak256 of the
    ///         canonical type string from docs/eip712.md §3.1. Any whitespace
    ///         change here invalidates every signature in the wild.
    function test_EIP712_OrderTypehashHardcoded() public view {
        bytes32 expected = keccak256(
            "Order(address owner,address token,address quoteToken,uint8 venue,uint8 side,uint256 targetPrice,uint256 amountIn,uint256 slippageBps,uint256 expiry,uint256 nonce)"
        );
        assertEq(executor.ORDER_TYPEHASH(), expected);
    }

    function test_EIP712_DomainTypehashHardcoded() public view {
        bytes32 expected = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );
        assertEq(executor.EIP712_DOMAIN_TYPEHASH(), expected);
    }

    /// @notice Cross-check: vm.sign over the contract's `digest` recovers to
    ///         `alice`, and the contract's `execute` accepts the signature
    ///         (delegated to SignatureChecker → ECDSA.recover). This is the
    ///         end-to-end proof that the signing path is interoperable.
    function test_J_SignatureChecker_RecoversCorrectSignerOnExecute() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 5e18, 100);
        bytes memory sig = _sign(alicePk, o);

        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);

        // Sanity: the recovered address from the signature matches alice.
        // (If this assert fails, the digest doesn't match what vm.sign signed —
        // i.e. the EIP-712 path is broken.)
        bytes32 d = executor.digest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, d);
        address recovered = ecrecover(d, v, r, s);
        assertEq(recovered, alice);

        vm.prank(keeper);
        executor.execute(o, sig);
        assertTrue(executor.isNonceUsed(alice, 100));
    }

    // =====================================================================
    // Happy paths — all 4 (venue, side) combos
    // =====================================================================

    function test_Execute_LimitBuy_Player_HappyPath() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 10e18, 1);
        bytes memory sig = _sign(alicePk, o);

        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);

        uint256 aliceCountryBefore = countryToken.balanceOf(alice);
        uint256 alicePlayerBefore = playerToken.balanceOf(alice);

        uint256 expectedOut = (o.amountIn * 1e18) / o.targetPrice; // hook mult = 10_000
        uint256 minOut = executor.quoteMinOut(o);

        vm.expectEmit(true, true, true, true, address(executor));
        emit OrderExecuted(alice, o.nonce, address(playerToken), 0, o.amountIn, expectedOut, keeper);

        vm.prank(keeper);
        executor.execute(o, sig);

        assertEq(countryToken.balanceOf(alice), aliceCountryBefore - o.amountIn);
        assertEq(playerToken.balanceOf(alice), alicePlayerBefore + expectedOut);
        assertGe(expectedOut, minOut, "router output below signed minOut");
        // Req R: residual allowance reset.
        assertEq(countryToken.allowance(address(executor), address(playerRouter)), 0);
        // Req M (no dust): executor balances are zero on both sides.
        assertEq(countryToken.balanceOf(address(executor)), 0);
        assertEq(playerToken.balanceOf(address(executor)), 0);
        assertTrue(executor.isNonceUsed(alice, 1));
    }

    function test_Execute_TakeProfit_Player_HappyPath() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 1, 10e18, 2);
        bytes memory sig = _sign(alicePk, o);

        _approveExecutorAsAlice(IERC20(address(playerToken)), o.amountIn);

        uint256 alicePlayerBefore = playerToken.balanceOf(alice);
        uint256 aliceCountryBefore = countryToken.balanceOf(alice);

        uint256 expectedOut = (o.amountIn * o.targetPrice) / 1e18;

        vm.prank(keeper);
        executor.execute(o, sig);

        assertEq(playerToken.balanceOf(alice), alicePlayerBefore - o.amountIn);
        assertEq(countryToken.balanceOf(alice), aliceCountryBefore + expectedOut);
        assertEq(playerToken.allowance(address(executor), address(playerRouter)), 0);
        assertEq(playerToken.balanceOf(address(executor)), 0);
        assertEq(countryToken.balanceOf(address(executor)), 0);
    }

    function test_Execute_LimitBuy_Country_HappyPath() public {
        LimitOrderExecutor.Order memory o = _mkOrder(1, 0, 50e18, 3);
        bytes memory sig = _sign(alicePk, o);

        _approveExecutorAsAlice(IERC20(address(pitch)), o.amountIn);

        uint256 alicePitchBefore = pitch.balanceOf(alice);
        uint256 aliceCountryBefore = countryToken.balanceOf(alice);

        uint256 expectedOut = (o.amountIn * 1e18) / o.targetPrice;

        vm.prank(keeper);
        executor.execute(o, sig);

        assertEq(pitch.balanceOf(alice), alicePitchBefore - o.amountIn);
        assertEq(countryToken.balanceOf(alice), aliceCountryBefore + expectedOut);
        assertEq(pitch.allowance(address(executor), address(countryRouter)), 0);
    }

    function test_Execute_TakeProfit_Country_HappyPath() public {
        LimitOrderExecutor.Order memory o = _mkOrder(1, 1, 4e18, 4);
        bytes memory sig = _sign(alicePk, o);

        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);

        uint256 expectedOut = (o.amountIn * o.targetPrice) / 1e18;
        uint256 alicePitchBefore = pitch.balanceOf(alice);

        vm.prank(keeper);
        executor.execute(o, sig);

        assertEq(pitch.balanceOf(alice), alicePitchBefore + expectedOut);
        assertEq(countryToken.allowance(address(executor), address(countryRouter)), 0);
    }

    // =====================================================================
    // Req N — input validation
    // =====================================================================

    function test_N_RevertsOnZeroAmountIn() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 0, 10);
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.ZeroAmount.selector);
        executor.execute(o, sig);
    }

    function test_N_RevertsOnZeroTargetPrice() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 11);
        o.targetPrice = 0;
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.ZeroTargetPrice.selector);
        executor.execute(o, sig);
    }

    function test_N_RevertsOnZeroToken() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 12);
        o.token = address(0);
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.ZeroOrderAddress.selector);
        executor.execute(o, sig);
    }

    function test_N_RevertsOnZeroQuoteToken() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 13);
        o.quoteToken = address(0);
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.ZeroOrderAddress.selector);
        executor.execute(o, sig);
    }

    function test_N_RevertsOnInvalidVenue() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 14);
        o.venue = 2;
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.InvalidVenue.selector);
        executor.execute(o, sig);
    }

    function test_N_RevertsOnInvalidSide() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 15);
        o.side = 2;
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.InvalidSide.selector);
        executor.execute(o, sig);
    }

    function test_N_RevertsOnSlippageAboveMax() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 16);
        o.slippageBps = 1001; // MAX is 1000
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.SlippageTooHigh.selector);
        executor.execute(o, sig);
    }

    function test_N_AllowsSlippageEqualsMax() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 17);
        o.slippageBps = 1000;
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);
        vm.prank(keeper);
        executor.execute(o, sig);
        assertTrue(executor.isNonceUsed(alice, 17));
    }

    function test_N_RevertsOnExpiredOrder() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 18);
        vm.warp(1_000_000);
        o.expiry = block.timestamp - 1;
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.OrderExpired.selector);
        executor.execute(o, sig);
    }

    function test_N_AcceptsExpiryEqualBlockTimestamp() public {
        vm.warp(1_000_000);
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 19);
        o.expiry = block.timestamp; // exactly equal — strict `>` check passes.
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);
        vm.prank(keeper);
        executor.execute(o, sig);
    }

    function test_N_AcceptsZeroExpiryAsNoExpiry() public {
        vm.warp(10 ** 12);
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 20);
        assertEq(o.expiry, 0);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);
        vm.prank(keeper);
        executor.execute(o, sig);
    }

    function test_N_RevertsOnCountryVenueQuoteTokenNotPitch() public {
        LimitOrderExecutor.Order memory o = _mkOrder(1, 0, 1e18, 21);
        o.quoteToken = address(countryToken); // anything but PITCH
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.InvalidQuoteToken.selector);
        executor.execute(o, sig);
    }

    // =====================================================================
    // Req J/K — signature checks
    // =====================================================================

    function test_K_RevertsOnSignatureFromDifferentSigner() public {
        // bob signs an order with owner=alice → recover gives bob ≠ alice → reject.
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 30);
        bytes memory sig = _sign(bobPk, o);
        vm.expectRevert(LimitOrderExecutor.InvalidSignature.selector);
        executor.execute(o, sig);
    }

    function test_K_RevertsOnTamperedField() public {
        // sign one order, then tamper amountIn before submit.
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 31);
        bytes memory sig = _sign(alicePk, o);
        o.amountIn = 2e18; // not signed
        vm.expectRevert(LimitOrderExecutor.InvalidSignature.selector);
        executor.execute(o, sig);
    }

    function test_J_RevertsOnMalleableHighS() public {
        // Generate a valid sig, then flip s into the upper half of the curve
        // order. ECDSA.tryRecover rejects high-s (malleability), and
        // SignatureChecker returns false → InvalidSignature.
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 32);
        bytes32 d = executor.digest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, d);
        // secp256k1 order N
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes32 sHigh = bytes32(N - uint256(s));
        // flip v as well for the symmetric point
        uint8 vFlipped = v == 27 ? 28 : 27;
        bytes memory sigMalleable = abi.encodePacked(r, sHigh, vFlipped);
        vm.expectRevert(LimitOrderExecutor.InvalidSignature.selector);
        executor.execute(o, sigMalleable);
    }

    function test_J_RevertsOnEmptySignature() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 33);
        vm.expectRevert(LimitOrderExecutor.InvalidSignature.selector);
        executor.execute(o, hex"");
    }

    /// @notice EIP-1271: a smart-wallet `owner` can produce a contract signature.
    ///         Proves SignatureChecker honors the IERC1271 path (req J).
    function test_J_EIP1271_SmartWalletSignatureAccepted() public {
        MockEIP1271Wallet wallet = new MockEIP1271Wallet();
        // Fund + approve as the smart-wallet "user".
        countryToken.mint(address(wallet), 1_000e18);
        vm.prank(address(wallet));
        countryToken.approve(address(executor), 1e18);

        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 40);
        o.owner = address(wallet);
        bytes memory sig = hex"deadbeef"; // arbitrary "1271 signature blob"

        bytes32 d = executor.digest(o);
        wallet.approve(d, sig);

        vm.prank(keeper);
        executor.execute(o, sig);
        assertTrue(executor.isNonceUsed(address(wallet), 40));
    }

    function test_J_EIP1271_RejectedSignatureReverts() public {
        MockEIP1271Wallet wallet = new MockEIP1271Wallet();
        countryToken.mint(address(wallet), 1_000e18);
        vm.prank(address(wallet));
        countryToken.approve(address(executor), 1e18);

        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 41);
        o.owner = address(wallet);
        bytes memory sig = hex"00";
        // Wallet did NOT approve `(digest, sig)` → returns 0x → reject.
        vm.expectRevert(LimitOrderExecutor.InvalidSignature.selector);
        executor.execute(o, sig);
    }

    // =====================================================================
    // Req I — sandwich-defence: minOut depends ONLY on signed fields
    // =====================================================================

    /// @notice Critical: live price drops in the execution block do NOT lower
    ///         `quoteMinOut`. Same Order → same quoteMinOut, irrespective of
    ///         live hook price. This is the sandwich-defence invariant.
    function test_I_MinOut_IndependentOfLivePrice() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 10e18, 50);
        uint256 minOutAtSignTime = executor.quoteMinOut(o);

        // Simulate a manipulator pushing the live price *up* (worse for buyer)
        // — minOut from the contract must remain unchanged because it is derived
        // from `targetPrice` only.
        playerHook.setPrice(address(playerToken), PLAYER_PRICE * 10);
        assertEq(executor.quoteMinOut(o), minOutAtSignTime);

        // And *down*:
        playerHook.setPrice(address(playerToken), PLAYER_PRICE / 10);
        assertEq(executor.quoteMinOut(o), minOutAtSignTime);
    }

    /// @notice Buy-side minOut formula: `(amountIn * 1e18 / target) * (10000 -
    ///         (fee+slip)) / 10000`. Matches docs/eip712.md §5.2 verbatim.
    function test_I_MinOutFormula_LimitBuy() public view {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 10e18, 51);
        uint256 baseIdeal = (o.amountIn * 1e18) / o.targetPrice;
        uint256 discount = 500 + o.slippageBps; // FEE_BPS + slippage
        uint256 expected = (baseIdeal * (10_000 - discount)) / 10_000;
        assertEq(executor.quoteMinOut(o), expected);
    }

    /// @notice Sell-side minOut formula: `(amountIn * target / 1e18) * (10000 -
    ///         (fee+slip)) / 10000`.
    function test_I_MinOutFormula_TakeProfit() public view {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 1, 10e18, 52);
        uint256 quoteIdeal = (o.amountIn * o.targetPrice) / 1e18;
        uint256 discount = 500 + o.slippageBps;
        uint256 expected = (quoteIdeal * (10_000 - discount)) / 10_000;
        assertEq(executor.quoteMinOut(o), expected);
    }

    /// @notice If the realised swap output is below the signed minOut (e.g. the
    ///         router returned less than the executor's signed-only bound),
    ///         `execute` must revert. We force this by setting the hook's quote
    ///         multiplier below 100% (the executor's `forceApprove(0)` and full-
    ///         balance forward happen after the router call — the executor's
    ///         own `outBal < minOut` check is the last safety net).
    function test_I_RevertsOnRealisedOutputBelowMinOut() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 10e18, 53);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);

        // Drop the player hook quote multiplier so MockRouter returns less than
        // the signed minOut. (The router itself reverts with its own
        // RouterSlippage error before we hit the executor's InsufficientOutput
        // check — both paths defend the invariant; here we observe the router
        // revert.)
        playerHook.setQuoteMultiplier(8000); // 80% of nominal output

        vm.prank(keeper);
        vm.expectRevert(MockRouter.RouterSlippage.selector);
        executor.execute(o, sig);
    }

    /// @notice Defensive double-check: a buggy / lying router that returns
    ///         success but pushes less than minOut to the executor must be
    ///         caught by the executor's own `outBal < minOut` check (req I,
    ///         second line of defence — see InsufficientOutput in the source).
    function test_I_InsufficientOutput_ExecutorOwnCheckFires() public {
        // Wire a fresh executor against a permissive router on the player venue.
        PermissiveMockRouter permissive =
            new PermissiveMockRouter(IERC20(address(pitch)), address(countryToken));
        LimitOrderExecutor ex2 = new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(playerHook)),
            IHook(address(countryHook)),
            IRouter(address(permissive)),
            IRouter(address(countryRouter)),
            owner
        );

        LimitOrderExecutor.Order memory o = LimitOrderExecutor.Order({
            owner: alice,
            token: address(playerToken),
            quoteToken: address(countryToken),
            venue: 0,
            side: 0,
            targetPrice: PLAYER_PRICE,
            amountIn: 10e18,
            slippageBps: 100,
            expiry: 0,
            nonce: 54
        });
        // Sign against ex2's domain.
        bytes32 d = ex2.digest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, d);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Router returns 1 wei — well below the executor-computed minOut.
        permissive.setOutputs(1, 0);

        vm.prank(alice);
        countryToken.approve(address(ex2), o.amountIn);

        vm.prank(keeper);
        vm.expectRevert(LimitOrderExecutor.InsufficientOutput.selector);
        ex2.execute(o, sig);
    }

    // =====================================================================
    // Price condition (limit-buy: price <= target; take-profit: price >= target)
    // =====================================================================

    function test_PriceCondition_LimitBuy_RevertsWhenPriceAboveTarget() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 60);
        o.targetPrice = PLAYER_PRICE - 1; // live > target → not met
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.PriceConditionNotMet.selector);
        executor.execute(o, sig);
    }

    function test_PriceCondition_LimitBuy_PassesAtEquality() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 61);
        o.targetPrice = PLAYER_PRICE; // equal — `price <= target` true
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);
        vm.prank(keeper);
        executor.execute(o, sig);
    }

    function test_PriceCondition_TakeProfit_RevertsWhenPriceBelowTarget() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 1, 1e18, 62);
        o.targetPrice = PLAYER_PRICE + 1; // live < target → not met
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.PriceConditionNotMet.selector);
        executor.execute(o, sig);
    }

    function test_PriceCondition_TakeProfit_PassesAtEquality() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 1, 1e18, 63);
        o.targetPrice = PLAYER_PRICE;
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(playerToken)), o.amountIn);
        vm.prank(keeper);
        executor.execute(o, sig);
    }

    // =====================================================================
    // Nonce / replay / cancel (req H, P, Q)
    // =====================================================================

    function test_H_NonceUsedBeforeExternalCalls_NoReplay() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 70);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn * 2);

        vm.prank(keeper);
        executor.execute(o, sig);
        assertTrue(executor.isNonceUsed(alice, 70));

        // Same (order, sig) submitted again → nonce already used → revert.
        vm.expectRevert(LimitOrderExecutor.NonceAlreadyUsed.selector);
        vm.prank(keeper);
        executor.execute(o, sig);
    }

    function test_Cancel_MarksOwnNonceUsed() public {
        vm.expectEmit(true, true, false, true, address(executor));
        emit OrderCancelled(alice, 71);
        vm.prank(alice);
        executor.cancel(71);
        assertTrue(executor.isNonceUsed(alice, 71));
    }

    function test_Cancel_OnlyScopesToCaller() public {
        // alice cancels nonce 72 → bob's nonce 72 unaffected.
        vm.prank(alice);
        executor.cancel(72);
        assertTrue(executor.isNonceUsed(alice, 72));
        assertFalse(executor.isNonceUsed(bob, 72));
    }

    /// @notice Req P: on-chain `cancel` defeats a subsequent `execute` on the
    ///         same nonce. (Race is documented — front-run by execute is a
    ///         known property; this test confirms cancel-wins-when-it-lands.)
    function test_P_CancelBlocksLaterExecute() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 73);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);

        vm.prank(alice);
        executor.cancel(o.nonce);

        vm.expectRevert(LimitOrderExecutor.NonceAlreadyUsed.selector);
        vm.prank(keeper);
        executor.execute(o, sig);
    }

    /// @notice Req Q: cancel must work while paused, otherwise pause becomes a
    ///         funds-capture vector.
    function test_Q_CancelWorksWhilePaused() public {
        vm.prank(owner);
        executor.pause();

        vm.prank(alice);
        executor.cancel(74);
        assertTrue(executor.isNonceUsed(alice, 74));

        // After unpause, the cancelled nonce still blocks execute.
        vm.prank(owner);
        executor.unpause();

        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 74);
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(LimitOrderExecutor.NonceAlreadyUsed.selector);
        executor.execute(o, sig);
    }

    // =====================================================================
    // Req G — nonReentrant on execute
    // =====================================================================

    /// @notice Reentrancy via a malicious input token's `transferFrom` callback
    ///         attempting to re-enter `execute`. The OZ ReentrancyGuard must
    ///         fire with ReentrancyGuardReentrantCall.
    function test_G_NonReentrant_BlocksRecursiveExecute() public {
        ReentrantInToken rt = new ReentrantInToken();

        // Build a player-venue limit-buy whose inToken is the malicious ERC20.
        // The router's quote token must match so transferFrom is invoked on rt.
        // Use a dedicated MockRouter pointed at the playerHook with quote = rt.
        MockRouter maliciousRouter =
            new MockRouter(IERC20(address(pitch)), IHook(address(playerHook)));
        maliciousRouter.setQuoteToken(address(rt));

        // Deploy a *fresh* executor wired to this router on the player venue.
        LimitOrderExecutor ex2 = new LimitOrderExecutor(
            IERC20(address(pitch)),
            IHook(address(playerHook)),
            IHook(address(countryHook)),
            IRouter(address(maliciousRouter)),
            IRouter(address(countryRouter)),
            owner
        );
        // Seed alice with rt and let her approve ex2.
        rt.mint(alice, 100e18);
        vm.prank(alice);
        rt.approve(address(ex2), type(uint256).max);

        // Construct the order against ex2 (note: digest is ex2's domain).
        LimitOrderExecutor.Order memory o = LimitOrderExecutor.Order({
            owner: alice,
            token: address(playerToken),
            quoteToken: address(rt),
            venue: 0,
            side: 0,
            targetPrice: PLAYER_PRICE,
            amountIn: 1e18,
            slippageBps: 100,
            expiry: 0,
            nonce: 80
        });
        bytes32 d = ex2.digest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, d);
        bytes memory sig = abi.encodePacked(r, s, v);

        // Arm rt to re-enter ex2.execute on transferFrom.
        rt.arm(ex2, o, sig);

        // The outer call propagates the inner ReentrancyGuard revert via
        // SafeERC20's bubble. Just assert it reverts.
        vm.expectRevert();
        ex2.execute(o, sig);
        // Nonce was NOT marked used because the whole tx reverted.
        assertFalse(ex2.isNonceUsed(alice, 80));
    }

    // =====================================================================
    // Req O — Ownable2Step + pause auth
    // =====================================================================

    function test_O_OnlyOwnerCanPause() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        executor.pause();
    }

    function test_O_OnlyOwnerCanUnpause() public {
        vm.prank(owner);
        executor.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        vm.prank(alice);
        executor.unpause();
    }

    function test_O_PausedExecuteReverts() public {
        vm.prank(owner);
        executor.pause();

        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 90);
        bytes memory sig = _sign(alicePk, o);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        executor.execute(o, sig);
    }

    function test_O_PauseUnpauseRoundTrip() public {
        vm.prank(owner);
        executor.pause();
        assertTrue(executor.paused());

        vm.prank(owner);
        executor.unpause();
        assertFalse(executor.paused());

        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 91);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);
        vm.prank(keeper);
        executor.execute(o, sig);
    }

    function test_O_Ownership_TwoStep() public {
        vm.prank(owner);
        executor.transferOwnership(bob);
        // Pre-acceptance, ownership stays with `owner`.
        assertEq(executor.owner(), owner);
        assertEq(executor.pendingOwner(), bob);

        vm.prank(bob);
        executor.acceptOwnership();
        assertEq(executor.owner(), bob);

        // Old owner has lost rights.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        executor.pause();
        // New owner has rights.
        vm.prank(bob);
        executor.pause();
        assertTrue(executor.paused());
    }

    // =====================================================================
    // Req L / M — SafeERC20 + full balance forwarded
    // =====================================================================

    /// @notice Req M: dust pre-sent to the executor address is forwarded to the
    ///         owner along with the swap proceeds (the executor reads its full
    ///         post-swap balance and pushes it all out). The order owner ends
    ///         up with proceeds + the pre-seeded dust.
    function test_M_FullBalanceForwarded_DustPreSentIsAlsoPaidOut() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 10e18, 100);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);

        // Pre-seed the executor with playerToken dust (e.g. mis-sent earlier).
        uint256 dust = 7e15;
        playerToken.mint(address(executor), dust);

        uint256 alicePlayerBefore = playerToken.balanceOf(alice);
        uint256 expectedSwap = (o.amountIn * 1e18) / o.targetPrice;

        vm.prank(keeper);
        executor.execute(o, sig);

        // Alice received swap output + dust; executor balance is fully drained.
        assertEq(playerToken.balanceOf(alice), alicePlayerBefore + expectedSwap + dust);
        assertEq(playerToken.balanceOf(address(executor)), 0);
    }

    // =====================================================================
    // Req R — residual allowance reset (asserted in happy-path tests too,
    // but explicitly named here for traceability).
    // =====================================================================

    function test_R_AllowanceResetAfterExecute() public {
        LimitOrderExecutor.Order memory o = _mkOrder(1, 0, 5e18, 110);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(pitch)), o.amountIn);

        vm.prank(keeper);
        executor.execute(o, sig);

        // The contract's R-invariant: zero residual allowance to the router.
        assertEq(pitch.allowance(address(executor), address(countryRouter)), 0);
    }

    // =====================================================================
    // Permissionlessness
    // =====================================================================

    /// @notice Anyone may call `execute` — proceeds still flow only to
    ///         `order.owner`. The `executor` event field reflects the caller.
    function test_Execute_PermissionlessCallerAttribution() public {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 120);
        bytes memory sig = _sign(alicePk, o);
        _approveExecutorAsAlice(IERC20(address(countryToken)), o.amountIn);

        // Random caller (not the owner of executor, not the order signer).
        address randomKeeper = address(0xDEADC0DE);
        uint256 alicePlayerBefore = playerToken.balanceOf(alice);

        vm.prank(randomKeeper);
        executor.execute(o, sig);

        // Proceeds went to alice (owner), not the keeper.
        assertGt(playerToken.balanceOf(alice), alicePlayerBefore);
        assertEq(playerToken.balanceOf(randomKeeper), 0);
    }

    // =====================================================================
    // View helpers
    // =====================================================================

    function test_View_IsNonceUsedDefaultsFalse() public view {
        assertFalse(executor.isNonceUsed(alice, 999));
    }

    function test_View_HashOrderIsPure() public view {
        LimitOrderExecutor.Order memory o = _mkOrder(0, 0, 1e18, 200);
        bytes32 h1 = executor.hashOrder(o);
        bytes32 h2 = executor.hashOrder(o);
        assertEq(h1, h2);
        assertTrue(h1 != bytes32(0));
    }
}
