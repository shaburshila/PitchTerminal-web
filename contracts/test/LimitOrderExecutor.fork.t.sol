// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { LimitOrderExecutor } from "../src/LimitOrderExecutor.sol";
import { IHook } from "../src/interfaces/IHook.sol";
import { IRouter } from "../src/interfaces/IRouter.sol";

/// @title LimitOrderExecutorForkTest
/// @notice C2.4 — Fork-test against Base mainnet (chainId 8453). Deploys a
///         FRESH `LimitOrderExecutor` wired to the REAL pitchwc routers / hooks
///         / PITCH ERC20 / country & player tokens and runs the full `execute`
///         flow on all four (venue, side) combos:
///             1. player venue, limit-buy   (spend country → receive player)
///             2. player venue, take-profit (spend player  → receive country)
///             3. country venue, limit-buy   (spend PITCH   → receive country)
///             4. country venue, take-profit (spend country → receive PITCH)
///
///         All test balances come from `vm.deal` / `deal(token, ...)` — we
///         never `vm.prank` a real holder (would be brittle if the holder moves
///         funds). Per the C2.4 spec in `docs/plans/contracts.md` the suite
///         skips itself cleanly when `BASE_RPC_URL` is not set, so the default
///         CI run (which has no RPC endpoint) stays green. Run locally with:
///
///             BASE_RPC_URL=https://mainnet.base.org \
///                 forge test --match-contract LimitOrderExecutorForkTest -vv
///
///         (Or `FORK_RPC_URL=...` — both env names are accepted; the former
///         matches `docs/plans/contracts.md` §C2.4, the latter matches the
///         existing `AnvilForkTest` convention.)
///
/// @dev    The price condition in the order is built off the live hook price
///         queried inside `setUp`, so the test does not depend on a particular
///         market state — only that `currentPrice(token) > 0`. `slippageBps`
///         is set to the contract maximum (1000 = 10%) to tolerate any
///         post-fork-block price drift from the curve fee model and keep the
///         four-combo suite robust against minor pitchwc behavior changes.
contract LimitOrderExecutorForkTest is Test {
    // ---------------------------------------------------------------------
    // Real Base mainnet addresses
    // (canonical references: `config.py`, `.env.example`, `tokens.json`).
    // ---------------------------------------------------------------------

    /// @notice PITCH ERC20 — quote token for country venue.
    address internal constant PITCH_MAINNET = 0xeaE13ea73BEc936664A51734c8c01ec7c3B0699C;

    /// @notice Player router (player <-> country swaps).
    address internal constant PLAYER_ROUTER_MAINNET = 0x5F231AEA5AbD403aF0e8a32c1feF85a9a3ec5622;

    /// @notice Country router (country <-> PITCH swaps).
    address internal constant COUNTRY_ROUTER_MAINNET = 0x61Cad011Db02D9924257F536bFD1ea615e42Bb9D;

    /// @notice Player hook — price oracle for player tokens (quote = country).
    address internal constant PLAYER_HOOK_MAINNET = 0xd5252A67935fc6b913C4441ac0E5EBF3219fAAa8;

    /// @notice Country hook — price oracle for country tokens (quote = PITCH).
    address internal constant COUNTRY_HOOK_MAINNET = 0xCAE7EbFa18755d1f35eE8e0F3356f375ed5B2Aa8;

    /// @notice USA country token (`tokens.json` countries[0]).
    address internal constant COUNTRY_TOKEN_MAINNET = 0x174068620334470F76f00F59EdAF3d218F38E191;

    /// @notice PULISIC player token (`tokens.json` players[0], country USA).
    address internal constant PLAYER_TOKEN_MAINNET = 0xd4849ada288029581A3185f39Fbc715730666b76;

    // ---------------------------------------------------------------------
    // Test fixtures
    // ---------------------------------------------------------------------

    LimitOrderExecutor internal executor;

    IERC20 internal pitch = IERC20(PITCH_MAINNET);
    IERC20 internal country = IERC20(COUNTRY_TOKEN_MAINNET);
    IERC20 internal player = IERC20(PLAYER_TOKEN_MAINNET);

    IHook internal playerHook = IHook(PLAYER_HOOK_MAINNET);
    IHook internal countryHook = IHook(COUNTRY_HOOK_MAINNET);

    address internal owner = makeAddr("owner");
    address internal keeper = makeAddr("keeper");
    address internal alice; // order signer (EOA derived from privkey)
    uint256 internal alicePk;

    // Live prices snapshotted in setUp — used to build orders whose
    // `targetPrice` satisfies both sides (price <= target AND price >= target
    // is impossible, so each test sets its own target relative to live price).
    uint256 internal livePlayerPrice;
    uint256 internal liveCountryPrice;

    // ---------------------------------------------------------------------
    // setUp — fork or skip
    // ---------------------------------------------------------------------

    function setUp() public {
        // Prefer the spec-mandated `BASE_RPC_URL` (docs/plans/contracts.md
        // §C2.4); fall back to `FORK_RPC_URL` so the same `vm.envExists`
        // convention as the existing `AnvilForkTest` keeps working.
        string memory rpc;
        if (vm.envExists("BASE_RPC_URL")) {
            rpc = vm.envString("BASE_RPC_URL");
        } else if (vm.envExists("FORK_RPC_URL")) {
            rpc = vm.envString("FORK_RPC_URL");
        } else {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(rpc);

        (alice, alicePk) = makeAddrAndKey("alice");

        // Deploy a fresh executor wired to the real pitchwc infrastructure.
        // `owner` is a throwaway address — the test never pauses / transfers
        // ownership on this fork-deployed instance; we only exercise the
        // permissionless `execute` path.
        vm.prank(owner);
        executor = new LimitOrderExecutor(
            pitch,
            playerHook,
            countryHook,
            IRouter(PLAYER_ROUTER_MAINNET),
            IRouter(COUNTRY_ROUTER_MAINNET),
            owner
        );

        // Snapshot live prices once so each test can pick `targetPrice` such
        // that its side-specific condition (`livePrice <= target` for buy,
        // `livePrice >= target` for take-profit) is satisfied at execute time.
        livePlayerPrice = playerHook.currentPrice(PLAYER_TOKEN_MAINNET);
        liveCountryPrice = countryHook.currentPrice(COUNTRY_TOKEN_MAINNET);

        // Both must be non-zero or the tokens are unlisted on the fork block.
        require(livePlayerPrice > 0, "player price 0 on fork");
        require(liveCountryPrice > 0, "country price 0 on fork");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Sign an EIP-712 order with `alicePk` against the fork-deployed
    ///      executor's domain separator.
    function _sign(LimitOrderExecutor.Order memory o) internal view returns (bytes memory) {
        bytes32 digest = executor.digest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(alicePk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Top up `alice` with `amount` of `token` via `deal` (writes the
    ///      balance slot directly — no real holder dependency) and approve
    ///      the fork-deployed executor for the spend.
    function _fundAndApprove(IERC20 token, uint256 amount) internal {
        deal(address(token), alice, amount, true); // adjust totalSupply too
        vm.prank(alice);
        token.approve(address(executor), amount);
    }

    // ---------------------------------------------------------------------
    // 1/4 — Player venue, limit-buy
    //       spend country (quote) → receive player (base).
    //       target chosen >= live price so `livePrice <= target` holds.
    // ---------------------------------------------------------------------

    function test_Fork_PlayerVenue_LimitBuy() public {
        uint256 amountIn = 1e16; // 0.01 country token — small spend
        LimitOrderExecutor.Order memory o = LimitOrderExecutor.Order({
            owner: alice,
            token: PLAYER_TOKEN_MAINNET,
            quoteToken: COUNTRY_TOKEN_MAINNET,
            venue: 0,
            side: 0,
            // 10x live price as target — buy condition `live <= target` is
            // trivially satisfied while still being a "realistic" limit price.
            targetPrice: livePlayerPrice * 10,
            amountIn: amountIn,
            slippageBps: 1000, // max — robust against curve fee model surprises
            expiry: 0,
            nonce: uint256(keccak256("player.limit-buy"))
        });
        bytes memory sig = _sign(o);
        _fundAndApprove(country, amountIn);

        uint256 alicePlayerBefore = player.balanceOf(alice);
        uint256 aliceCountryBefore = country.balanceOf(alice);

        vm.prank(keeper);
        executor.execute(o, sig);

        // Country spent in full, player received > 0, executor drained.
        assertEq(country.balanceOf(alice), aliceCountryBefore - amountIn, "country spent");
        assertGt(player.balanceOf(alice) - alicePlayerBefore, 0, "received player tokens");
        assertEq(country.balanceOf(address(executor)), 0, "no country dust");
        assertEq(player.balanceOf(address(executor)), 0, "no player dust");
        // Req R: residual allowance reset.
        assertEq(country.allowance(address(executor), PLAYER_ROUTER_MAINNET), 0, "allowance reset");
        assertTrue(executor.isNonceUsed(alice, o.nonce), "nonce consumed");
    }

    // ---------------------------------------------------------------------
    // 2/4 — Player venue, take-profit
    //       spend player (base) → receive country (quote).
    //       target chosen <= live price so `livePrice >= target` holds.
    // ---------------------------------------------------------------------

    function test_Fork_PlayerVenue_TakeProfit() public {
        uint256 amountIn = 1e16;
        LimitOrderExecutor.Order memory o = LimitOrderExecutor.Order({
            owner: alice,
            token: PLAYER_TOKEN_MAINNET,
            quoteToken: COUNTRY_TOKEN_MAINNET,
            venue: 0,
            side: 1,
            // 1/10 live price as target — sell condition `live >= target` is
            // trivially satisfied while still being a "realistic" take-profit.
            targetPrice: livePlayerPrice / 10,
            amountIn: amountIn,
            slippageBps: 1000,
            expiry: 0,
            nonce: uint256(keccak256("player.take-profit"))
        });
        bytes memory sig = _sign(o);
        _fundAndApprove(player, amountIn);

        uint256 alicePlayerBefore = player.balanceOf(alice);
        uint256 aliceCountryBefore = country.balanceOf(alice);

        vm.prank(keeper);
        executor.execute(o, sig);

        assertEq(player.balanceOf(alice), alicePlayerBefore - amountIn, "player spent");
        assertGt(country.balanceOf(alice) - aliceCountryBefore, 0, "received country tokens");
        assertEq(player.balanceOf(address(executor)), 0, "no player dust");
        assertEq(country.balanceOf(address(executor)), 0, "no country dust");
        assertEq(player.allowance(address(executor), PLAYER_ROUTER_MAINNET), 0, "allowance reset");
        assertTrue(executor.isNonceUsed(alice, o.nonce), "nonce consumed");
    }

    // ---------------------------------------------------------------------
    // 3/4 — Country venue, limit-buy
    //       spend PITCH (quote) → receive country (base).
    // ---------------------------------------------------------------------

    function test_Fork_CountryVenue_LimitBuy() public {
        uint256 amountIn = 1e16; // 0.01 PITCH
        LimitOrderExecutor.Order memory o = LimitOrderExecutor.Order({
            owner: alice,
            token: COUNTRY_TOKEN_MAINNET,
            quoteToken: PITCH_MAINNET, // req N: country venue MUST use PITCH
            venue: 1,
            side: 0,
            targetPrice: liveCountryPrice * 10,
            amountIn: amountIn,
            slippageBps: 1000,
            expiry: 0,
            nonce: uint256(keccak256("country.limit-buy"))
        });
        bytes memory sig = _sign(o);
        _fundAndApprove(pitch, amountIn);

        uint256 alicePitchBefore = pitch.balanceOf(alice);
        uint256 aliceCountryBefore = country.balanceOf(alice);

        vm.prank(keeper);
        executor.execute(o, sig);

        assertEq(pitch.balanceOf(alice), alicePitchBefore - amountIn, "pitch spent");
        assertGt(country.balanceOf(alice) - aliceCountryBefore, 0, "received country tokens");
        assertEq(pitch.balanceOf(address(executor)), 0, "no pitch dust");
        assertEq(country.balanceOf(address(executor)), 0, "no country dust");
        assertEq(pitch.allowance(address(executor), COUNTRY_ROUTER_MAINNET), 0, "allowance reset");
        assertTrue(executor.isNonceUsed(alice, o.nonce), "nonce consumed");
    }

    // ---------------------------------------------------------------------
    // 4/4 — Country venue, take-profit
    //       spend country (base) → receive PITCH (quote).
    // ---------------------------------------------------------------------

    function test_Fork_CountryVenue_TakeProfit() public {
        uint256 amountIn = 1e16; // 0.01 country
        LimitOrderExecutor.Order memory o = LimitOrderExecutor.Order({
            owner: alice,
            token: COUNTRY_TOKEN_MAINNET,
            quoteToken: PITCH_MAINNET,
            venue: 1,
            side: 1,
            targetPrice: liveCountryPrice / 10,
            amountIn: amountIn,
            slippageBps: 1000,
            expiry: 0,
            nonce: uint256(keccak256("country.take-profit"))
        });
        bytes memory sig = _sign(o);
        _fundAndApprove(country, amountIn);

        uint256 alicePitchBefore = pitch.balanceOf(alice);
        uint256 aliceCountryBefore = country.balanceOf(alice);

        vm.prank(keeper);
        executor.execute(o, sig);

        assertEq(country.balanceOf(alice), aliceCountryBefore - amountIn, "country spent");
        assertGt(pitch.balanceOf(alice) - alicePitchBefore, 0, "received PITCH");
        assertEq(country.balanceOf(address(executor)), 0, "no country dust");
        assertEq(pitch.balanceOf(address(executor)), 0, "no pitch dust");
        assertEq(country.allowance(address(executor), COUNTRY_ROUTER_MAINNET), 0, "allowance reset");
        assertTrue(executor.isNonceUsed(alice, o.nonce), "nonce consumed");
    }

    // ---------------------------------------------------------------------
    // 5/5 — Expiry boundary against real chain state.
    //       Confirms the strict `>` semantics (`expiry == block.timestamp`
    //       passes, `expiry == block.timestamp - 1` reverts) on mainnet so the
    //       only execute-path the four-combo suite leaves uncovered is
    //       exercised against the real EVM.
    // ---------------------------------------------------------------------

    function test_Fork_ExpiryBoundary_EqualAcceptsPastRejects() public {
        uint256 amountIn = 1e16;

        // 1) expiry == block.timestamp — must pass (`> expiry` check is strict).
        LimitOrderExecutor.Order memory ok = LimitOrderExecutor.Order({
            owner: alice,
            token: COUNTRY_TOKEN_MAINNET,
            quoteToken: PITCH_MAINNET,
            venue: 1,
            side: 0,
            targetPrice: liveCountryPrice * 10,
            amountIn: amountIn,
            slippageBps: 1000,
            expiry: block.timestamp,
            nonce: uint256(keccak256("expiry.boundary.equal"))
        });
        bytes memory sigOk = _sign(ok);
        _fundAndApprove(pitch, amountIn);

        vm.prank(keeper);
        executor.execute(ok, sigOk);
        assertTrue(executor.isNonceUsed(alice, ok.nonce), "boundary-equal accepted");

        // 2) expiry == block.timestamp - 1 — must revert OrderExpired.
        LimitOrderExecutor.Order memory expired = LimitOrderExecutor.Order({
            owner: alice,
            token: COUNTRY_TOKEN_MAINNET,
            quoteToken: PITCH_MAINNET,
            venue: 1,
            side: 0,
            targetPrice: liveCountryPrice * 10,
            amountIn: amountIn,
            slippageBps: 1000,
            expiry: block.timestamp - 1,
            nonce: uint256(keccak256("expiry.boundary.past"))
        });
        bytes memory sigExp = _sign(expired);
        // No allowance needed — the bounds check fires before any token movement.

        vm.expectRevert(LimitOrderExecutor.OrderExpired.selector);
        vm.prank(keeper);
        executor.execute(expired, sigExp);
    }

    // ---------------------------------------------------------------------
    // Sanity: real hook returns >0 prices on the fork block.
    // ---------------------------------------------------------------------

    function test_Fork_LiveHookPricesNonZero() public view {
        assertGt(livePlayerPrice, 0, "player live price");
        assertGt(liveCountryPrice, 0, "country live price");
        // Re-read via the executor's hook references (same address; this
        // proves the executor's immutables point at the real pitchwc oracles).
        assertEq(
            executor.PLAYER_HOOK().currentPrice(PLAYER_TOKEN_MAINNET),
            livePlayerPrice,
            "player hook wired"
        );
        assertEq(
            executor.COUNTRY_HOOK().currentPrice(COUNTRY_TOKEN_MAINNET),
            liveCountryPrice,
            "country hook wired"
        );
    }
}
