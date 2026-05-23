// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PitchTerminalAccess
/// @notice One-time PITCH payment unlocks premium access to PitchTerminal forever.
///         Owner can additionally grant/revoke free access via a whitelist.
///         Two-sided referral programme (Model C): when a buyer supplies a valid
///         referrer, the buyer receives a discount (`buyerDiscountBps` of the full
///         `price`), the referrer receives a cashback (`referralBps` of the full
///         `price`), and the treasury receives the remainder. Without a valid
///         referrer the buyer pays the full `price` and the treasury receives all
///         of it — no discount is applied. The contract never holds tokens: every
///         share is moved directly from the buyer in the same transaction.
/// @dev    Security requirements (see docs/contracts.md §1):
///         - A. CEI: `paid` is set BEFORE any external token transfer (referral and
///              treasury legs); `buyAccess` is also protected by `nonReentrant`.
///         - B. All ERC20 movements go through `SafeERC20`.
///         - C. Two-step ownership transfer via `Ownable2Step`.
///         - D. Constructor rejects zero addresses for `pitch`, `treasury`, `owner`,
///              zero / out-of-bounds initial `price`, and
///              `buyerDiscountBps + referralBps` exceeding MAX_TOTAL_REFERRAL_BPS.
///         - E. Contract is NOT payable: no `receive()` / `fallback()` — interacts only
///              with the PITCH ERC20. Funds always flow buyer → (referrer + treasury)
///              in the same transaction; the contract never holds a balance.
///         - F. ASSUMPTION: PITCH is a well-behaved ERC20 — no fee-on-transfer, no
///              rebasing, no reentrant callbacks on `transferFrom`. This contract is
///              not designed to support deviant token semantics; deploying it against
///              a different token would void the security guarantees below.
///         - G. `setPrice` is bounded by `MAX_PRICE = 100e18` (100 PITCH) — limits the
///              blast radius of an owner-key compromise (attacker cannot make access
///              unrealistically expensive — DoS — or accidentally free).
///         - H. `setReferralSplit` is bounded: `buyerDiscountBps + referralBps` may
///              never exceed `MAX_TOTAL_REFERRAL_BPS = 5000` (50%). Treasury is
///              therefore guaranteed at least 50% of every purchase even if the
///              owner key is compromised. Setting both to `0` is allowed
///              (kill-switch without redeploy).
///         - I. Rounding invariant: for any `price ∈ (0, MAX_PRICE]` and any
///              `(discount, ref)` with `discount + ref ≤ MAX_TOTAL_REFERRAL_BPS`,
///              when the referrer is valid `referralAmount + treasuryAmount ==
///              buyerPaid`; when the referrer is invalid `treasuryAmount == price`.
///              No lost wei: treasury always collects the remainder of the buyer's
///              payment.
///         - J. `referrer == msg.sender`, `referrer == address(this)`, and
///              `referrer == address(PITCH)` are treated as "no referrer" (silent skip,
///              not revert). Prevents accidental self-links and griefing via
///              `?ref=<dead address>` from breaking the UX or silently burning the
///              referral share at an unrecoverable address (no rescue function).
///         `treasury` is immutable: even a compromised owner cannot redirect proceeds.
contract PitchTerminalAccess is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Immutables / constants
    // ---------------------------------------------------------------------

    /// @notice PITCH ERC20 token used for payment.
    IERC20 public immutable PITCH;

    /// @notice Recipient of access payments. Immutable — cannot be changed by owner.
    address public immutable TREASURY;

    /// @notice Upper bound on the access price, in PITCH wei (18 decimals).
    /// @dev Hard cap defends against owner-key compromise (req G).
    uint256 public constant MAX_PRICE = 100e18;

    /// @notice Maximum number of addresses per `grantBatch` call (gas-bound).
    uint256 public constant MAX_BATCH = 100;

    /// @notice Hard cap on the sum of `buyerDiscountBps + referralBps`, in basis
    ///         points (50%).
    /// @dev Defends against owner-key compromise (req H): even a malicious owner
    ///      cannot route more than half of the full price away from the treasury
    ///      (whether as a referrer kickback, as a buyer discount, or both
    ///      combined). Treasury is guaranteed at least 50% of every purchase.
    uint16 public constant MAX_TOTAL_REFERRAL_BPS = 5000;

    // ---------------------------------------------------------------------
    // Mutable state
    // ---------------------------------------------------------------------

    /// @notice Current access price, in PITCH wei.
    uint256 public price;

    /// @notice Current buyer discount, in basis points of the full `price`.
    /// @dev When a buyer supplies a valid referrer, the buyer pays only
    ///      `price * (10000 - buyerDiscountBps) / 10000` PITCH instead of the
    ///      full `price`. Without a valid referrer the buyer always pays the
    ///      full `price` (no discount). Updated atomically together with
    ///      `referralBps` via `setReferralSplit`; the invariant
    ///      `buyerDiscountBps + referralBps <= MAX_TOTAL_REFERRAL_BPS` is
    ///      enforced on every write.
    uint16 public buyerDiscountBps;

    /// @notice Current referrer cashback share, in basis points of the full `price`.
    /// @dev When a buyer supplies a valid referrer, the referrer receives
    ///      `price * referralBps / 10000` PITCH directly from the buyer. Setting
    ///      this to `0` disables the cashback leg even when `buyerDiscountBps > 0`
    ///      — the buyer still gets the discount; the referrer simply receives
    ///      nothing and the event reports "no referrer" (kill-switch for the
    ///      cashback side of the programme).
    uint16 public referralBps;

    /// @notice Addresses that have purchased access by paying `price` PITCH.
    mapping(address => bool) public paid;

    /// @notice Addresses granted free access by the owner.
    mapping(address => bool) public whitelisted;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when a user purchases access by paying PITCH.
    /// @param user            The buyer.
    /// @param referrer        The referrer that received `referralAmount`, or
    ///                        `address(0)` when no referrer payout occurred (no-ref
    ///                        purchase, self-ref, self-contract, or
    ///                        `referralBps == 0`).
    /// @param buyerPaid       PITCH amount the buyer actually paid. Equal to
    ///                        `price` without a valid referrer; equal to
    ///                        `price * (10000 - buyerDiscountBps) / 10000` with a
    ///                        valid referrer. Treasury received
    ///                        `buyerPaid - referralAmount`.
    /// @param referralAmount  PITCH amount sent to `referrer`. Zero when no
    ///                        referrer payout occurred.
    event AccessPurchased(
        address indexed user, address indexed referrer, uint256 buyerPaid, uint256 referralAmount
    );

    /// @notice Emitted when the owner grants free access to a user.
    event AccessGranted(address indexed user);

    /// @notice Emitted when the owner revokes a user's whitelisted access.
    /// @dev Does NOT affect `paid[user]` — purchased access is permanent.
    event AccessRevoked(address indexed user);

    /// @notice Emitted when the owner changes the access price.
    event PriceChanged(uint256 newPrice);

    /// @notice Emitted when the owner atomically updates the referral split.
    /// @param newBuyerDiscountBps  New buyer-side discount, in basis points.
    /// @param newReferralBps       New referrer-side cashback, in basis points.
    event ReferralSplitUpdated(uint16 newBuyerDiscountBps, uint16 newReferralBps);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice A zero address was supplied where a non-zero address is required.
    error ZeroAddress();

    /// @notice The supplied price is zero or exceeds `MAX_PRICE`.
    error InvalidPrice();

    /// @notice The supplied `buyerDiscountBps + referralBps` exceeds
    ///         `MAX_TOTAL_REFERRAL_BPS`.
    error InvalidReferralSplit();

    /// @notice The caller already has access (purchased or whitelisted).
    error AlreadyHasAccess();

    /// @notice `grantBatch` was called with more than `MAX_BATCH` addresses.
    error BatchTooLarge();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param _pitch              PITCH ERC20 token used for payment. Must be non-zero.
    /// @param _treasury           Recipient of access payments. Must be non-zero.
    ///                            Immutable.
    /// @param _price              Initial access price, in PITCH wei. Must satisfy
    ///                            `0 < _price <= MAX_PRICE`.
    /// @param _buyerDiscountBps   Initial buyer discount, in basis points.
    /// @param _referralBps        Initial referrer cashback, in basis points. The sum
    ///                            `_buyerDiscountBps + _referralBps` must satisfy
    ///                            `<= MAX_TOTAL_REFERRAL_BPS`. Both zero is allowed
    ///                            (referral programme disabled at deploy).
    /// @param _owner              Initial owner (Ownable2Step). Non-zero check delegated
    ///                            to OpenZeppelin `Ownable` which reverts with
    ///                            `OwnableInvalidOwner(address(0))` before our body runs.
    constructor(
        IERC20 _pitch,
        address _treasury,
        uint256 _price,
        uint16 _buyerDiscountBps,
        uint16 _referralBps,
        address _owner
    ) Ownable(_owner) {
        if (address(_pitch) == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_price == 0 || _price > MAX_PRICE) revert InvalidPrice();
        if (uint256(_buyerDiscountBps) + uint256(_referralBps) > MAX_TOTAL_REFERRAL_BPS) {
            revert InvalidReferralSplit();
        }

        PITCH = _pitch;
        TREASURY = _treasury;
        price = _price;
        buyerDiscountBps = _buyerDiscountBps;
        referralBps = _referralBps;
    }

    // ---------------------------------------------------------------------
    // User-facing
    // ---------------------------------------------------------------------

    /// @notice Pay PITCH to unlock premium access permanently. With a valid referrer
    ///         the buyer receives a discount and the referrer receives a cashback;
    ///         without one the buyer pays the full `price`.
    /// @param  referrer  Optional referral address. When valid (non-zero, not the
    ///                   buyer, not this contract): buyer pays
    ///                   `price * (10000 - buyerDiscountBps) / 10000`, referrer
    ///                   receives `price * referralBps / 10000`, treasury receives
    ///                   the remainder of the buyer's payment. If `referralBps == 0`
    ///                   the buyer still receives the discount but the referrer
    ///                   receives nothing (cashback kill-switch). `address(0)`,
    ///                   self-referral and the contract's own address are treated
    ///                   as "no referrer" (silent skip, no revert; see req J) — in
    ///                   that case the buyer pays the full `price` with no discount.
    /// @dev    Reverts with `AlreadyHasAccess` if the caller already has access
    ///         (either purchased or whitelisted). State is mutated BEFORE any external
    ///         transfer (CEI) and the call is `nonReentrant` (req A).
    ///         The PITCH allowance for this contract must cover the buyer's payment.
    ///         Rounding follows req I: with a valid referrer
    ///         `referralAmount + treasuryAmount == buyerPaid`; otherwise
    ///         `treasuryAmount == price`.
    function buyAccess(address referrer) external nonReentrant {
        if (hasAccess(msg.sender)) revert AlreadyHasAccess();

        // Checks-Effects-Interactions: flip state BEFORE the external call (req A).
        paid[msg.sender] = true;

        // A referral is valid only if the address is non-zero, not the buyer, not
        // this contract, and not the PITCH token contract itself (req J — silent skip
        // on self-ref / self-contract / pitch-token to defang grief vectors where a
        // shared "?ref=<dead address>" would burn the referrer share into a void).
        bool hasReferral = referrer != address(0) && referrer != msg.sender
            && referrer != address(this) && referrer != address(PITCH);

        if (hasReferral) {
            uint256 buyerPaid = (price * (10000 - uint256(buyerDiscountBps))) / 10000;
            uint256 referralAmount = (price * uint256(referralBps)) / 10000;
            // Invariant H guarantees buyerDiscountBps + referralBps <= 5000, so
            // referralAmount <= price/2 <= buyerPaid; the subtraction below cannot
            // underflow (Solidity 0.8 would catch it regardless — defence in depth
            // for req I).
            uint256 treasuryAmount = buyerPaid - referralAmount;

            if (referralAmount == 0) {
                // Cashback kill-switch (referralBps == 0): buyer keeps the discount,
                // treasury receives the buyer's full payment, referrer receives
                // nothing and the event reports "no referrer".
                PITCH.safeTransferFrom(msg.sender, TREASURY, buyerPaid);
                emit AccessPurchased(msg.sender, address(0), buyerPaid, 0);
            } else {
                // Two transfers from the buyer: referrer first, then treasury. Both
                // must succeed for the purchase to settle (atomic). SafeERC20 reverts
                // on a failed / non-standard ERC20 (req B).
                PITCH.safeTransferFrom(msg.sender, referrer, referralAmount);
                PITCH.safeTransferFrom(msg.sender, TREASURY, treasuryAmount);
                emit AccessPurchased(msg.sender, referrer, buyerPaid, referralAmount);
            }
        } else {
            // No-ref / self-ref / self-contract: full payment to treasury, no
            // discount (req J).
            PITCH.safeTransferFrom(msg.sender, TREASURY, price);
            emit AccessPurchased(msg.sender, address(0), price, 0);
        }
    }

    /// @notice Returns true iff `user` has premium access (paid OR whitelisted).
    function hasAccess(address user) public view returns (bool) {
        return paid[user] || whitelisted[user];
    }

    // ---------------------------------------------------------------------
    // Owner operations
    // ---------------------------------------------------------------------

    /// @notice Grant `user` free access via the whitelist.
    /// @dev    onlyOwner. Reverts on zero address.
    function grantAccess(address user) external onlyOwner {
        if (user == address(0)) revert ZeroAddress();
        whitelisted[user] = true;
        emit AccessGranted(user);
    }

    /// @notice Grant free access to a batch of users.
    /// @dev    onlyOwner. The batch is capped at `MAX_BATCH` (100) to bound gas;
    ///         larger whitelists must be split across multiple transactions.
    ///         Reverts if any entry is the zero address.
    function grantBatch(address[] calldata users) external onlyOwner {
        uint256 len = users.length;
        if (len > MAX_BATCH) revert BatchTooLarge();
        for (uint256 i = 0; i < len; i++) {
            address user = users[i];
            if (user == address(0)) revert ZeroAddress();
            whitelisted[user] = true;
            emit AccessGranted(user);
        }
    }

    /// @notice Revoke `user`'s whitelisted access.
    /// @dev    onlyOwner. Does NOT touch `paid[user]` — purchased access is permanent
    ///         and cannot be revoked by the owner. Rejects `address(0)` for symmetry
    ///         with `grantAccess` / `grantBatch` — prevents the owner from accidentally
    ///         polluting event logs with `AccessRevoked(0x0)`.
    function revokeAccess(address user) external onlyOwner {
        if (user == address(0)) revert ZeroAddress();
        whitelisted[user] = false;
        emit AccessRevoked(user);
    }

    /// @notice Set a new access price.
    /// @dev    onlyOwner. Bounded: `0 < newPrice <= MAX_PRICE` (req G).
    function setPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0 || newPrice > MAX_PRICE) revert InvalidPrice();
        price = newPrice;
        emit PriceChanged(newPrice);
    }

    /// @notice Atomically update both sides of the referral split.
    /// @dev    onlyOwner. Bounded: `newBuyerDiscountBps + newReferralBps <=
    ///         MAX_TOTAL_REFERRAL_BPS` (req H). `(0, 0)` is allowed (kill-switch).
    ///         The atomic two-argument setter is required so that a rebalance
    ///         like (10%, 40%) → (40%, 10%) can happen in a single call without
    ///         transiently violating the sum invariant.
    function setReferralSplit(uint16 newBuyerDiscountBps, uint16 newReferralBps)
        external
        onlyOwner
    {
        if (uint256(newBuyerDiscountBps) + uint256(newReferralBps) > MAX_TOTAL_REFERRAL_BPS) {
            revert InvalidReferralSplit();
        }
        buyerDiscountBps = newBuyerDiscountBps;
        referralBps = newReferralBps;
        emit ReferralSplitUpdated(newBuyerDiscountBps, newReferralBps);
    }

    // No `receive()` / `fallback()` — the contract is intentionally non-payable (req E).
    // Ownership transfer uses `Ownable2Step.transferOwnership` / `acceptOwnership` (req C).
}
