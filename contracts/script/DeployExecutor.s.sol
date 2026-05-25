// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { LimitOrderExecutor } from "../src/LimitOrderExecutor.sol";
import { IHook } from "../src/interfaces/IHook.sol";
import { IRouter } from "../src/interfaces/IRouter.sol";

/// @title DeployExecutor
/// @notice Foundry deploy script for `LimitOrderExecutor` (Phase 2 C2.6).
///
/// Required env vars (mainnet values come from .env.example — already pinned
/// to the live pitchwc.app addresses; OWNER defaults to shaburshila.base.eth
/// `0x71ECD1a09380cA46CcA741Bc48d04C556674756F`).
///
///   - PITCH_TOKEN     (address) — PITCH ERC20.
///   - PLAYER_HOOK     (address) — pitchwc player hook.
///   - COUNTRY_HOOK    (address) — pitchwc country hook.
///   - PLAYER_ROUTER   (address) — pitchwc player router.
///   - COUNTRY_ROUTER  (address) — pitchwc country router.
///   - OWNER           (address) — Ownable2Step initial owner.
///
/// Usage:
///   - Dry-run (simulate, no broadcast):
///       forge script script/DeployExecutor.s.sol --rpc-url $RPC_URL_BASE_MAINNET
///   - Anvil fork (smoke):
///       anvil --fork-url $RPC_URL_BASE_MAINNET --fork-block-number <recent>
///       forge script script/DeployExecutor.s.sol \
///           --rpc-url http://127.0.0.1:8545 --broadcast --unlocked --sender 0x<OWNER>
///   - Mainnet (Ledger):
///       forge script script/DeployExecutor.s.sol \
///           --rpc-url $RPC_URL_BASE_MAINNET --account ledger --sender 0x<OWNER> \
///           --broadcast --verify --etherscan-api-key $BASESCAN_KEY
///
/// Post-deploy:
///   - Rotate `EXECUTOR_CONTRACT` env on the VPS (currently
///     `0x0000…` placeholder → `/api/v1/orders` fail-closed). See
///     `docs/conventions.md` §9.
contract DeployExecutor is Script {
    function run() external returns (LimitOrderExecutor executor) {
        // --- 1. Read constructor arguments from env ---------------------------------
        address pitch = vm.envAddress("PITCH_TOKEN");
        address playerHook = vm.envAddress("PLAYER_HOOK");
        address countryHook = vm.envAddress("COUNTRY_HOOK");
        address playerRouter = vm.envAddress("PLAYER_ROUTER");
        address countryRouter = vm.envAddress("COUNTRY_ROUTER");
        address owner = vm.envAddress("OWNER");

        // --- 2. Log the parameters --------------------------------------------------
        console2.log("Deploying LimitOrderExecutor with:");
        console2.log("  pitch token   :", pitch);
        console2.log("  player hook   :", playerHook);
        console2.log("  country hook  :", countryHook);
        console2.log("  player router :", playerRouter);
        console2.log("  country router:", countryRouter);
        console2.log("  owner         :", owner);

        // --- 3. Broadcast the deploy -----------------------------------------------
        vm.startBroadcast();
        executor = new LimitOrderExecutor(
            IERC20(pitch),
            IHook(playerHook),
            IHook(countryHook),
            IRouter(playerRouter),
            IRouter(countryRouter),
            owner
        );
        vm.stopBroadcast();

        // --- 4. Post-deploy assertions (paranoid mode) ------------------------------
        require(address(executor).code.length > 0, "deploy: no code at address");
        require(executor.owner() == owner, "deploy: owner not set to OWNER");
        require(address(executor.PITCH()) == pitch, "deploy: PITCH mismatch");
        require(address(executor.PLAYER_HOOK()) == playerHook, "deploy: PLAYER_HOOK mismatch");
        require(address(executor.COUNTRY_HOOK()) == countryHook, "deploy: COUNTRY_HOOK mismatch");
        require(address(executor.PLAYER_ROUTER()) == playerRouter, "deploy: PLAYER_ROUTER mismatch");
        require(
            address(executor.COUNTRY_ROUTER()) == countryRouter, "deploy: COUNTRY_ROUTER mismatch"
        );

        console2.log("Deployed LimitOrderExecutor at:", address(executor));
    }
}
