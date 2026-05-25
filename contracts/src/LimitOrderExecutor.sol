// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IHook } from "./interfaces/IHook.sol";
import { IRouter } from "./interfaces/IRouter.sol";

/// @title LimitOrderExecutor
/// @notice Permissionless executor for EIP-712-signed limit orders against pitchwc
///         player and country bonding curves. Users sign an `Order` off-chain; any
///         caller may submit `execute(order, signature)` once the price condition
///         is met — the signed `targetPrice` + `slippageBps` (NOT the live price)
///         determine `minOut`, so manipulation in the execution block cannot
///         degrade the user's fill below the threshold they signed.
/// @dev    Security requirements (see docs/contracts.md §2 G-R and docs/eip712.md
///         §3, §5, §6):
///         - G. `nonReentrant` on `execute` — multiple external calls including the
///              external `isValidSignature` callback for EIP-1271 smart wallets.
///         - H. CEI: `usedNonces[owner][nonce] = true` is written BEFORE any
///              external token transfer or router call.
///         - I. `minOut` is computed from the signed `targetPrice` + `slippageBps`
///              ONLY, never from the live curve price — the key sandwich-defence
///              property the auditor must verify.
///         - J. Signature verification is delegated to OpenZeppelin
///              `SignatureChecker` (ECDSA + EIP-1271); manual `ecrecover` is
///              forbidden — closes signature malleability (high-s) and zero-signer
///              vectors automatically.
///         - K. Signature is verified against `order.owner` — orders are bound to
///              their signer; an executor cannot reuse another user's signature.
///         - L. All ERC20 movement uses `SafeERC20` (`safeTransferFrom`,
///              `safeTransfer`, `forceApprove`).
///         - M. The OWNER receives the FULL outToken balance held by the executor
///              at swap-end (not a computed amount) — guarantees no dust accrues
///              on the executor across orders.
///         - N. Input validation: amountIn > 0, valid venue, valid side,
///              slippageBps ≤ MAX_SLIPPAGE_BPS, expiry passed check, non-zero
///              token / quoteToken / owner, country-venue quoteToken == PITCH.
///         - O. `Ownable2Step` — owner-key compromise is bounded to DoS-pause; it
///              cannot redirect funds (no rescue, no swap routing override, no
///              treasury setter).
///         - P. The on-chain `cancel` may be front-run by `execute`; instant
///              cancellation is server-side, on-chain `cancel` exists for the
///              strictly trustless path.
///         - Q. `cancel` is NOT guarded by `whenNotPaused` — a user MUST be able
///              to invalidate their nonce even while the contract is paused,
///              otherwise pause would become a funds capture.
///         - R. After every `router.buy`/`router.sell`, allowance to the router is
///              forcibly reset to 0 — defensive against router bugs that leave
///              residual allowance, and asserted as a per-execute invariant in
///              the test suite.
///         No `receive()` / `fallback()`: contract is not payable, never holds a
///         balance across transactions, and has no rescue function (sending tokens
///         directly to its address loses them — see docs/contracts.md §2).
contract LimitOrderExecutor is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Order struct
    // ---------------------------------------------------------------------

    /// @notice The signed limit-order payload. Field order is load-bearing — it
    ///         must match `ORDER_TYPEHASH` exactly and the viem `types.Order`
    ///         array on the frontend (see docs/eip712.md §3.2 and §3.4). Any
    ///         reordering changes the type hash and breaks every signature.
    /// @param owner        Wallet that signs and owns the order (also the funds
    ///                     source and the proceeds destination).
    /// @param token        The traded token (player or country).
    /// @param quoteToken   Quote currency of the pair: country-token for
    ///                     player-venue orders, PITCH for country-venue orders.
    ///                     Signed explicitly by the user because the on-chain
    ///                     `getBaseCurrency` helper of pitchwc is unreliable for
    ///                     part of the token registry (docs/eip712.md §3.3).
    /// @param venue        0 = player-venue, 1 = country-venue. Selects which
    ///                     immutable (hook, router) pair is used.
    /// @param side         0 = limit-buy (price falls to or below `targetPrice`),
    ///                     1 = take-profit (price rises to or above `targetPrice`).
    /// @param targetPrice  Trigger price, in quote-wei per 1 whole base unit
    ///                     (1e18 of base). Same scalar `IHook.currentPrice` returns.
    /// @param amountIn     Spend amount. For limit-buy this is `quoteToken` wei;
    ///                     for take-profit this is `token` wei.
    /// @param slippageBps  Slippage tolerance in basis points (1 bp = 0.01%).
    ///                     Bounded by `MAX_SLIPPAGE_BPS` (=1000 ⇒ 10%).
    /// @param expiry       Unix-seconds expiry; `0` = no expiry.
    /// @param nonce        Unique nonce per `(owner, contract)`. Recommended:
    ///                     cryptographically-random 256-bit value.
    struct Order {
        address owner;
        address token;
        address quoteToken;
        uint8 venue;
        uint8 side;
        uint256 targetPrice;
        uint256 amountIn;
        uint256 slippageBps;
        uint256 expiry;
        uint256 nonce;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Upper bound on `Order.slippageBps` (10%).
    /// @dev    Defends users against accidentally signing a wildly permissive
    ///         slippage value in a malformed UI.
    uint256 public constant MAX_SLIPPAGE_BPS = 1000;

    /// @notice Hardcoded pitchwc protocol fee (5%) used in `_minOut`.
    /// @dev    If pitchwc changes its fee this contract must be redeployed —
    ///         that is intentional: old signed orders with the previous fee
    ///         baked into `minOut` would otherwise execute on the new curve at
    ///         a worse rate than the user expected (docs/eip712.md §5.2).
    uint256 public constant FEE_BPS = 500;

    /// @notice Basis-points denominator (100% = 10_000 bps).
    uint256 public constant BPS_DENOM = 10_000;

    /// @notice Fixed-point ONE for 18-decimal price math.
    uint256 public constant ONE = 1e18;

    /// @notice EIP-712 domain typehash.
    bytes32 public constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @notice EIP-712 typehash for the `Order` struct.
    /// @dev    Must match the viem `types.Order` field list character-for-character
    ///         (docs/eip712.md §3.1). Any whitespace change invalidates every
    ///         existing signature.
    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address owner,address token,address quoteToken,uint8 venue,uint8 side,uint256 targetPrice,uint256 amountIn,uint256 slippageBps,uint256 expiry,uint256 nonce)"
    );

    /// @notice Human-readable domain name pinned into the EIP-712 domain.
    string public constant EIP712_DOMAIN_NAME = "PitchTerminal LimitOrders";

    /// @notice Domain version pinned into the EIP-712 domain.
    string public constant EIP712_DOMAIN_VERSION = "1";

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------

    /// @notice PITCH ERC20. Used as the required `quoteToken` for country-venue
    ///         orders (`venue == 1`).
    IERC20 public immutable PITCH;

    /// @notice Bonding-curve hook for player tokens (price oracle).
    IHook public immutable PLAYER_HOOK;

    /// @notice Bonding-curve hook for country tokens (price oracle).
    IHook public immutable COUNTRY_HOOK;

    /// @notice Swap router for player tokens.
    IRouter public immutable PLAYER_ROUTER;

    /// @notice Swap router for country tokens.
    IRouter public immutable COUNTRY_ROUTER;

    /// @notice Pre-computed EIP-712 domain separator. Immutable because chainId
    ///         and `address(this)` are fixed for the life of the contract — a
    ///         chain fork or contract migration would invalidate every signature
    ///         (intended replay protection).
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice `usedNonces[owner][nonce] == true` once that nonce has either
    ///         executed or been cancelled by the owner.
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted on a successful order execution.
    /// @param owner     Order signer (and proceeds recipient).
    /// @param nonce     The consumed nonce.
    /// @param token     The traded token.
    /// @param side      0 = limit-buy, 1 = take-profit (mirrors `Order.side`).
    /// @param amountIn  Spend amount actually pulled from the owner.
    /// @param amountOut Output token amount actually sent to the owner
    ///                  (= full executor balance of the output token after
    ///                  the swap; never a computed value, see req M).
    /// @param executor  `msg.sender` of the `execute` call — the keeper /
    ///                  caller that submitted the transaction. Useful for
    ///                  keeper-network attribution.
    event OrderExecuted(
        address indexed owner,
        uint256 indexed nonce,
        address indexed token,
        uint8 side,
        uint256 amountIn,
        uint256 amountOut,
        address executor
    );

    /// @notice Emitted when the owner of a nonce invalidates it on-chain.
    event OrderCancelled(address indexed owner, uint256 indexed nonce);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice A constructor argument was the zero address.
    error ZeroAddress();

    /// @notice `Order.amountIn` is zero.
    error ZeroAmount();

    /// @notice `Order.targetPrice` is zero.
    error ZeroTargetPrice();

    /// @notice `Order.owner`, `Order.token`, or `Order.quoteToken` is the zero
    ///         address. `owner == address(0)` is a defence-in-depth bound on top
    ///         of `SignatureChecker` (which already rejects sigs that recover to
    ///         the zero address).
    error ZeroOrderAddress();

    /// @notice `Order.venue` is not in {0, 1}.
    error InvalidVenue();

    /// @notice `Order.side` is not in {0, 1}.
    error InvalidSide();

    /// @notice `Order.slippageBps` exceeds `MAX_SLIPPAGE_BPS`.
    error SlippageTooHigh();

    /// @notice `Order.expiry` is in the past (non-zero and < `block.timestamp`).
    error OrderExpired();

    /// @notice The order's nonce has already been used or cancelled.
    error NonceAlreadyUsed();

    /// @notice For `venue == 1` (country), `quoteToken` must equal PITCH.
    error InvalidQuoteToken();

    /// @notice `SignatureChecker.isValidSignatureNow` returned false.
    error InvalidSignature();

    /// @notice The on-chain price did not satisfy the side-specific condition
    ///         (limit-buy: price > target; take-profit: price < target).
    error PriceConditionNotMet();

    /// @notice The realised swap output (full balance of outToken) was below
    ///         the signed-derived `minOut`. Defensive check — the router itself
    ///         should already revert on slippage, but the executor double-checks
    ///         using its own ground truth.
    error InsufficientOutput();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @notice Wire the executor to the pitchwc infrastructure.
    /// @param _pitch          PITCH ERC20 (used for country-venue quote validation).
    /// @param _playerHook     Hook for player-token prices.
    /// @param _countryHook    Hook for country-token prices.
    /// @param _playerRouter   Router for player-token swaps.
    /// @param _countryRouter  Router for country-token swaps.
    /// @param _owner          Initial owner (Ownable2Step). Zero-address rejected
    ///                        by OZ `Ownable` before our body runs.
    constructor(
        IERC20 _pitch,
        IHook _playerHook,
        IHook _countryHook,
        IRouter _playerRouter,
        IRouter _countryRouter,
        address _owner
    ) Ownable(_owner) {
        if (address(_pitch) == address(0)) revert ZeroAddress();
        if (address(_playerHook) == address(0)) revert ZeroAddress();
        if (address(_countryHook) == address(0)) revert ZeroAddress();
        if (address(_playerRouter) == address(0)) revert ZeroAddress();
        if (address(_countryRouter) == address(0)) revert ZeroAddress();

        PITCH = _pitch;
        PLAYER_HOOK = _playerHook;
        COUNTRY_HOOK = _countryHook;
        PLAYER_ROUTER = _playerRouter;
        COUNTRY_ROUTER = _countryRouter;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes(EIP712_DOMAIN_NAME)),
                keccak256(bytes(EIP712_DOMAIN_VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------------------------------------------------------------------
    // External: order lifecycle
    // ---------------------------------------------------------------------

    /// @notice Execute a signed limit order. Permissionless — any caller may
    ///         submit `(order, signature)` once the price condition is met; the
    ///         signer (`order.owner`) is the sole source of funds and sole
    ///         recipient of proceeds.
    /// @param  order     The signed `Order` (calldata, see struct doc above).
    /// @param  signature ECDSA or EIP-1271 signature over the EIP-712 digest of
    ///                   `order`. Verified by OZ `SignatureChecker`.
    /// @dev    Reverts on any of: paused, reentrancy, invalid bounds, expired,
    ///         nonce-used, country-venue quoteToken ≠ PITCH, invalid signature,
    ///         price condition not met, or realised output below `minOut`.
    ///         The nonce is marked used BEFORE the swap (CEI, req H). Allowance
    ///         to the router is reset to 0 after the swap (req R). The full
    ///         out-token balance is forwarded to the owner — no dust (req M).
    function execute(Order calldata order, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        // ---- Checks: cheap bounds first (fail fast, no SLOAD / external) ----
        if (order.amountIn == 0) revert ZeroAmount();
        if (order.targetPrice == 0) revert ZeroTargetPrice();
        if (
            order.owner == address(0) || order.token == address(0) || order.quoteToken == address(0)
        ) {
            revert ZeroOrderAddress();
        }
        if (order.venue > 1) revert InvalidVenue();
        if (order.side > 1) revert InvalidSide();
        if (order.slippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooHigh();
        // Validator timestamp drift (~15s) is irrelevant: orders expire in minutes-to-days.
        // forge-lint: disable-next-line(block-timestamp)
        if (order.expiry != 0 && block.timestamp > order.expiry) revert OrderExpired();

        // venue=country must use PITCH as quote (docs/eip712.md §6.1). Player
        // venue has no analogous on-chain check — relies on the router reverting
        // for an incompatible pair (self-DoS, not exploitable).
        if (order.venue == 1 && order.quoteToken != address(PITCH)) revert InvalidQuoteToken();

        // ---- Checks: nonce & signature ----
        if (usedNonces[order.owner][order.nonce]) revert NonceAlreadyUsed();

        bytes32 digest = _digest(order);
        if (!SignatureChecker.isValidSignatureNow(order.owner, digest, signature)) {
            revert InvalidSignature();
        }

        // ---- Checks: price condition (single external view call) ----
        IHook hook = _hookFor(order.venue);
        uint256 livePrice = hook.currentPrice(order.token);
        if (order.side == 0) {
            // limit-buy: trigger when market price has fallen to / below target.
            if (livePrice > order.targetPrice) revert PriceConditionNotMet();
        } else {
            // take-profit: trigger when market price has risen to / above target.
            if (livePrice < order.targetPrice) revert PriceConditionNotMet();
        }

        // ---- Effects: burn the nonce BEFORE any external token interaction ----
        usedNonces[order.owner][order.nonce] = true;

        // ---- Interactions: pull funds, swap, push proceeds ----
        (address inToken, address outToken) = _ioTokens(order);
        IRouter router = _routerFor(order.venue);
        uint256 minOut = _minOut(order);

        IERC20(inToken).safeTransferFrom(order.owner, address(this), order.amountIn);
        IERC20(inToken).forceApprove(address(router), order.amountIn);

        if (order.side == 0) {
            router.buy(order.token, order.amountIn, minOut);
        } else {
            router.sell(order.token, order.amountIn, minOut);
        }

        // Reset residual allowance — defensive against a router bug leaving
        // dust allowance behind. One SSTORE, zero-cost in our threat model
        // (req R). Asserted by `allowance(executor, router) == 0` test.
        IERC20(inToken).forceApprove(address(router), 0);

        // Forward the ENTIRE output-token balance (req M). The router pushes
        // proceeds to `msg.sender` (= this contract) on success; we don't
        // trust the router's return value, we read the post-swap balance.
        uint256 outBal = IERC20(outToken).balanceOf(address(this));
        if (outBal < minOut) revert InsufficientOutput();
        IERC20(outToken).safeTransfer(order.owner, outBal);

        emit OrderExecuted(
            order.owner, order.nonce, order.token, order.side, order.amountIn, outBal, msg.sender
        );
    }

    /// @notice Invalidate a nonce on-chain, preventing any future `execute` for
    ///         the corresponding signed order from `msg.sender`.
    /// @dev    NOT guarded by `whenNotPaused` (req Q): a paused executor must
    ///         still let users invalidate nonces, otherwise pause would become
    ///         a funds-capture vector. The owner of the order is `msg.sender`
    ///         here — this scopes cancellation to the signer regardless of who
    ///         might broadcast `execute` first. Reverts `NonceAlreadyUsed` if
    ///         the nonce was already consumed by `execute` or a prior `cancel`
    ///         — backend indexers rely on `OrderCancelled` not firing for
    ///         already-executed orders.
    function cancel(uint256 nonce) external {
        if (usedNonces[msg.sender][nonce]) revert NonceAlreadyUsed();
        usedNonces[msg.sender][nonce] = true;
        emit OrderCancelled(msg.sender, nonce);
    }

    /// @notice View helper mirroring `usedNonces[owner][nonce]`. Provided for
    ///         off-chain consumers (backend, frontend) that prefer an explicit
    ///         function selector to the auto-generated nested-mapping getter.
    function isNonceUsed(address owner, uint256 nonce) external view returns (bool) {
        return usedNonces[owner][nonce];
    }

    // ---------------------------------------------------------------------
    // External: owner controls
    // ---------------------------------------------------------------------

    /// @notice Pause `execute`. `cancel` remains callable (req Q).
    /// @dev    onlyOwner. Emergency stop only — owner cannot move funds.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume `execute`.
    /// @dev    onlyOwner.
    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Public / external views — EIP-712 helpers (auditable by viem)
    // ---------------------------------------------------------------------

    /// @notice EIP-712 struct hash of `order` (no domain prefix). Useful for the
    ///         viem ↔ Solidity cross-check ritual in docs/eip712.md §7.
    function hashOrder(Order calldata order) external pure returns (bytes32) {
        return _hashOrder(order);
    }

    /// @notice EIP-712 digest of `order` (with this contract's domain). The
    ///         frontend's `hashTypedData(...)` MUST return the same bytes.
    function digest(Order calldata order) external view returns (bytes32) {
        return _digest(order);
    }

    /// @notice The signed-only `minOut` for `order`, exposed for UI preview.
    function quoteMinOut(Order calldata order) external pure returns (uint256) {
        return _minOut(order);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    /// @dev Field order MUST match `ORDER_TYPEHASH` and viem's `types.Order`
    ///      (docs/eip712.md §3.2). `uint8` is promoted to a 32-byte word by
    ///      `abi.encode` — no manual padding required.
    function _hashOrder(Order calldata o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH,
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
    }

    function _digest(Order calldata o) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, _hashOrder(o)));
    }

    /// @dev minOut derives from the SIGNED `targetPrice` + `slippageBps` plus
    ///      the hardcoded `FEE_BPS` (5%). Never derives from live price — that
    ///      is the sandwich-defence (req I, docs/eip712.md §5.2).
    function _minOut(Order calldata o) internal pure returns (uint256) {
        // Combine protocol fee and user slippage as a single discount from the
        // signed ideal output. Sum is guaranteed to be < BPS_DENOM because the
        // execute-side bound `slippageBps <= 1000` keeps `discount <= 1500`.
        uint256 discount = FEE_BPS + o.slippageBps;
        if (o.side == 0) {
            // limit-buy: spend quoteToken, want baseToken.
            //   baseIdeal = amountIn * 1e18 / targetPrice
            uint256 baseIdeal = (o.amountIn * ONE) / o.targetPrice;
            return (baseIdeal * (BPS_DENOM - discount)) / BPS_DENOM;
        } else {
            // take-profit: sell baseToken, want quoteToken.
            //   quoteIdeal = amountIn * targetPrice / 1e18
            uint256 quoteIdeal = (o.amountIn * o.targetPrice) / ONE;
            return (quoteIdeal * (BPS_DENOM - discount)) / BPS_DENOM;
        }
    }

    /// @dev Map `Order.venue` → the immutable hook. Reverts on invalid venue,
    ///      but `execute` already gates this — kept as belt-and-braces for any
    ///      future caller of an internal helper. `view` (not `pure`) only
    ///      because Solidity's mutability analysis pre-0.8.x flagged immutable
    ///      reads; modern compilers allow `pure` but `view` keeps the helper
    ///      stable across re-introductions of stateful price logic.
    function _hookFor(uint8 venue) internal view returns (IHook) {
        if (venue == 0) return PLAYER_HOOK;
        if (venue == 1) return COUNTRY_HOOK;
        revert InvalidVenue();
    }

    /// @dev Map `Order.venue` → the immutable router (same caveat as `_hookFor`).
    function _routerFor(uint8 venue) internal view returns (IRouter) {
        if (venue == 0) return PLAYER_ROUTER;
        if (venue == 1) return COUNTRY_ROUTER;
        revert InvalidVenue();
    }

    /// @dev Map `Order.side` to (inToken, outToken):
    ///      - limit-buy (0): spend quoteToken, receive token.
    ///      - take-profit (1): spend token, receive quoteToken.
    function _ioTokens(Order calldata o) internal pure returns (address inToken, address outToken) {
        if (o.side == 0) {
            inToken = o.quoteToken;
            outToken = o.token;
        } else {
            inToken = o.token;
            outToken = o.quoteToken;
        }
    }

    // No `receive()` / `fallback()` — the contract is intentionally non-payable
    // and has no rescue function. Tokens transferred directly to its address
    // (outside of `execute`) are lost. The executor address must never be
    // surfaced as a deposit destination in any UI.
}
