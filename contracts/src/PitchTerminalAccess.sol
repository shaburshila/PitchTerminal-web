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
///         On-chain source of truth for premium status.
/// @dev    Security requirements (see docs/contracts.md §1):
///         - A. CEI: `paid` is set BEFORE the external token transfer; `buyAccess` is
///              also protected by `nonReentrant`.
///         - B. All ERC20 movements go through `SafeERC20`.
///         - C. Two-step ownership transfer via `Ownable2Step`.
///         - D. Constructor rejects zero addresses for `pitch`, `treasury`, `owner`
///              and zero / out-of-bounds initial `price`.
///         - E. Contract is NOT payable: no `receive()` / `fallback()` — interacts only
///              with the PITCH ERC20.
///         - F. ASSUMPTION: PITCH is a well-behaved ERC20 — no fee-on-transfer, no
///              rebasing, no reentrant callbacks on `transferFrom`. This contract is
///              not designed to support deviant token semantics; deploying it against
///              a different token would void the security guarantees below.
///         - G. `setPrice` is bounded by `MAX_PRICE = 100e18` (100 PITCH) — limits the
///              blast radius of an owner-key compromise (attacker cannot make access
///              unrealistically expensive — DoS — or accidentally free).
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

    // ---------------------------------------------------------------------
    // Mutable state
    // ---------------------------------------------------------------------

    /// @notice Current access price, in PITCH wei.
    uint256 public price;

    /// @notice Addresses that have purchased access by paying `price` PITCH.
    mapping(address => bool) public paid;

    /// @notice Addresses granted free access by the owner.
    mapping(address => bool) public whitelisted;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice Emitted when a user purchases access by paying PITCH.
    event AccessPurchased(address indexed user);

    /// @notice Emitted when the owner grants free access to a user.
    event AccessGranted(address indexed user);

    /// @notice Emitted when the owner revokes a user's whitelisted access.
    /// @dev Does NOT affect `paid[user]` — purchased access is permanent.
    event AccessRevoked(address indexed user);

    /// @notice Emitted when the owner changes the access price.
    event PriceChanged(uint256 newPrice);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    /// @notice A zero address was supplied where a non-zero address is required.
    error ZeroAddress();

    /// @notice The supplied price is zero or exceeds `MAX_PRICE`.
    error InvalidPrice();

    /// @notice The caller already has access (purchased or whitelisted).
    error AlreadyHasAccess();

    /// @notice `grantBatch` was called with more than `MAX_BATCH` addresses.
    error BatchTooLarge();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param _pitch    PITCH ERC20 token used for payment. Must be non-zero.
    /// @param _treasury Recipient of access payments. Must be non-zero. Immutable.
    /// @param _price    Initial access price, in PITCH wei. Must satisfy
    ///                  `0 < _price <= MAX_PRICE`.
    /// @param _owner    Initial owner (Ownable2Step). Must be non-zero.
    constructor(IERC20 _pitch, address _treasury, uint256 _price, address _owner) Ownable(_owner) {
        if (address(_pitch) == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_owner == address(0)) revert ZeroAddress();
        if (_price == 0 || _price > MAX_PRICE) revert InvalidPrice();

        PITCH = _pitch;
        TREASURY = _treasury;
        price = _price;
    }

    // ---------------------------------------------------------------------
    // User-facing
    // ---------------------------------------------------------------------

    /// @notice Pay `price` PITCH to unlock premium access permanently.
    /// @dev    Reverts with `AlreadyHasAccess` if the caller already has access
    ///         (either purchased or whitelisted). State is mutated BEFORE the external
    ///         transfer (CEI) and the call is `nonReentrant` (req A).
    ///         The PITCH allowance for this contract must cover `price`.
    function buyAccess() external nonReentrant {
        if (hasAccess(msg.sender)) revert AlreadyHasAccess();

        // Checks-Effects-Interactions: flip state BEFORE the external call (req A).
        paid[msg.sender] = true;

        // SafeERC20 reverts on a failed / non-standard ERC20 (req B).
        PITCH.safeTransferFrom(msg.sender, TREASURY, price);

        emit AccessPurchased(msg.sender);
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
    ///         and cannot be revoked by the owner.
    function revokeAccess(address user) external onlyOwner {
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

    // No `receive()` / `fallback()` — the contract is intentionally non-payable (req E).
    // Ownership transfer uses `Ownable2Step.transferOwnership` / `acceptOwnership` (req C).
}
