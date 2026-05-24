// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

// lib/openzeppelin-contracts/contracts/utils/Address.sol

// OpenZeppelin Contracts (last updated v5.0.0) (utils/Address.sol)

/**
 * @dev Collection of functions related to the address type
 */
library Address {
    /**
     * @dev The ETH balance of the account is not enough to perform the operation.
     */
    error AddressInsufficientBalance(address account);

    /**
     * @dev There's no code at `target` (it is not a contract).
     */
    error AddressEmptyCode(address target);

    /**
     * @dev A call to an address target failed. The target may have reverted.
     */
    error FailedInnerCall();

    /**
     * @dev Replacement for Solidity's `transfer`: sends `amount` wei to
     * `recipient`, forwarding all available gas and reverting on errors.
     *
     * https://eips.ethereum.org/EIPS/eip-1884[EIP1884] increases the gas cost
     * of certain opcodes, possibly making contracts go over the 2300 gas limit
     * imposed by `transfer`, making them unable to receive funds via
     * `transfer`. {sendValue} removes this limitation.
     *
     * https://consensys.net/diligence/blog/2019/09/stop-using-soliditys-transfer-now/[Learn more].
     *
     * IMPORTANT: because control is transferred to `recipient`, care must be
     * taken to not create reentrancy vulnerabilities. Consider using
     * {ReentrancyGuard} or the
     * https://solidity.readthedocs.io/en/v0.8.20/security-considerations.html#use-the-checks-effects-interactions-pattern[checks-effects-interactions pattern].
     */
    function sendValue(address payable recipient, uint256 amount) internal {
        if (address(this).balance < amount) {
            revert AddressInsufficientBalance(address(this));
        }

        (bool success, ) = recipient.call{value: amount}("");
        if (!success) {
            revert FailedInnerCall();
        }
    }

    /**
     * @dev Performs a Solidity function call using a low level `call`. A
     * plain `call` is an unsafe replacement for a function call: use this
     * function instead.
     *
     * If `target` reverts with a revert reason or custom error, it is bubbled
     * up by this function (like regular Solidity function calls). However, if
     * the call reverted with no returned reason, this function reverts with a
     * {FailedInnerCall} error.
     *
     * Returns the raw returned data. To convert to the expected return value,
     * use https://solidity.readthedocs.io/en/latest/units-and-global-variables.html?highlight=abi.decode#abi-encoding-and-decoding-functions[`abi.decode`].
     *
     * Requirements:
     *
     * - `target` must be a contract.
     * - calling `target` with `data` must not revert.
     */
    function functionCall(address target, bytes memory data) internal returns (bytes memory) {
        return functionCallWithValue(target, data, 0);
    }

    /**
     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],
     * but also transferring `value` wei to `target`.
     *
     * Requirements:
     *
     * - the calling contract must have an ETH balance of at least `value`.
     * - the called Solidity function must be `payable`.
     */
    function functionCallWithValue(address target, bytes memory data, uint256 value) internal returns (bytes memory) {
        if (address(this).balance < value) {
            revert AddressInsufficientBalance(address(this));
        }
        (bool success, bytes memory returndata) = target.call{value: value}(data);
        return verifyCallResultFromTarget(target, success, returndata);
    }

    /**
     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],
     * but performing a static call.
     */
    function functionStaticCall(address target, bytes memory data) internal view returns (bytes memory) {
        (bool success, bytes memory returndata) = target.staticcall(data);
        return verifyCallResultFromTarget(target, success, returndata);
    }

    /**
     * @dev Same as {xref-Address-functionCall-address-bytes-}[`functionCall`],
     * but performing a delegate call.
     */
    function functionDelegateCall(address target, bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory returndata) = target.delegatecall(data);
        return verifyCallResultFromTarget(target, success, returndata);
    }

    /**
     * @dev Tool to verify that a low level call to smart-contract was successful, and reverts if the target
     * was not a contract or bubbling up the revert reason (falling back to {FailedInnerCall}) in case of an
     * unsuccessful call.
     */
    function verifyCallResultFromTarget(
        address target,
        bool success,
        bytes memory returndata
    ) internal view returns (bytes memory) {
        if (!success) {
            _revert(returndata);
        } else {
            // only check if target is a contract if the call was successful and the return data is empty
            // otherwise we already know that it was a contract
            if (returndata.length == 0 && target.code.length == 0) {
                revert AddressEmptyCode(target);
            }
            return returndata;
        }
    }

    /**
     * @dev Tool to verify that a low level call was successful, and reverts if it wasn't, either by bubbling the
     * revert reason or with a default {FailedInnerCall} error.
     */
    function verifyCallResult(bool success, bytes memory returndata) internal pure returns (bytes memory) {
        if (!success) {
            _revert(returndata);
        } else {
            return returndata;
        }
    }

    /**
     * @dev Reverts with returndata if present. Otherwise reverts with {FailedInnerCall}.
     */
    function _revert(bytes memory returndata) private pure {
        // Look for revert reason and bubble it up if present
        if (returndata.length > 0) {
            // The easiest way to bubble the revert reason is using memory via assembly
            /// @solidity memory-safe-assembly
            assembly {
                let returndata_size := mload(returndata)
                revert(add(32, returndata), returndata_size)
            }
        } else {
            revert FailedInnerCall();
        }
    }
}

// lib/openzeppelin-contracts/contracts/utils/Context.sol

// OpenZeppelin Contracts (last updated v5.0.1) (utils/Context.sol)

/**
 * @dev Provides information about the current execution context, including the
 * sender of the transaction and its data. While these are generally available
 * via msg.sender and msg.data, they should not be accessed in such a direct
 * manner, since when dealing with meta-transactions the account sending and
 * paying for execution may not be the actual sender (as far as an application
 * is concerned).
 *
 * This contract is only required for intermediate, library-like contracts.
 */
abstract contract Context {
    function _msgSender() internal view virtual returns (address) {
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {
        return 0;
    }
}

// lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol

// OpenZeppelin Contracts (last updated v5.0.0) (token/ERC20/IERC20.sol)

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /**
     * @dev Returns the value of tokens in existence.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the value of tokens owned by `account`.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev Moves a `value` amount of tokens from the caller's account to `to`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transfer(address to, uint256 value) external returns (bool);

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    function allowance(address owner, address spender) external view returns (uint256);

    /**
     * @dev Sets a `value` amount of tokens as the allowance of `spender` over the
     * caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    function approve(address spender, uint256 value) external returns (bool);

    /**
     * @dev Moves a `value` amount of tokens from `from` to `to` using the
     * allowance mechanism. `value` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

// lib/openzeppelin-contracts/contracts/token/ERC20/extensions/IERC20Permit.sol

// OpenZeppelin Contracts (last updated v5.0.0) (token/ERC20/extensions/IERC20Permit.sol)

/**
 * @dev Interface of the ERC20 Permit extension allowing approvals to be made via signatures, as defined in
 * https://eips.ethereum.org/EIPS/eip-2612[EIP-2612].
 *
 * Adds the {permit} method, which can be used to change an account's ERC20 allowance (see {IERC20-allowance}) by
 * presenting a message signed by the account. By not relying on {IERC20-approve}, the token holder account doesn't
 * need to send a transaction, and thus is not required to hold Ether at all.
 *
 * ==== Security Considerations
 *
 * There are two important considerations concerning the use of `permit`. The first is that a valid permit signature
 * expresses an allowance, and it should not be assumed to convey additional meaning. In particular, it should not be
 * considered as an intention to spend the allowance in any specific way. The second is that because permits have
 * built-in replay protection and can be submitted by anyone, they can be frontrun. A protocol that uses permits should
 * take this into consideration and allow a `permit` call to fail. Combining these two aspects, a pattern that may be
 * generally recommended is:
 *
 * ```solidity
 * function doThingWithPermit(..., uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) public {
 *     try token.permit(msg.sender, address(this), value, deadline, v, r, s) {} catch {}
 *     doThing(..., value);
 * }
 *
 * function doThing(..., uint256 value) public {
 *     token.safeTransferFrom(msg.sender, address(this), value);
 *     ...
 * }
 * ```
 *
 * Observe that: 1) `msg.sender` is used as the owner, leaving no ambiguity as to the signer intent, and 2) the use of
 * `try/catch` allows the permit to fail and makes the code tolerant to frontrunning. (See also
 * {SafeERC20-safeTransferFrom}).
 *
 * Additionally, note that smart contract wallets (such as Argent or Safe) are not able to produce permit signatures, so
 * contracts should have entry points that don't rely on permit.
 */
interface IERC20Permit {
    /**
     * @dev Sets `value` as the allowance of `spender` over ``owner``'s tokens,
     * given ``owner``'s signed approval.
     *
     * IMPORTANT: The same issues {IERC20-approve} has related to transaction
     * ordering also apply here.
     *
     * Emits an {Approval} event.
     *
     * Requirements:
     *
     * - `spender` cannot be the zero address.
     * - `deadline` must be a timestamp in the future.
     * - `v`, `r` and `s` must be a valid `secp256k1` signature from `owner`
     * over the EIP712-formatted function arguments.
     * - the signature must use ``owner``'s current nonce (see {nonces}).
     *
     * For more information on the signature format, see the
     * https://eips.ethereum.org/EIPS/eip-2612#specification[relevant EIP
     * section].
     *
     * CAUTION: See Security Considerations above.
     */
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /**
     * @dev Returns the current nonce for `owner`. This value must be
     * included whenever a signature is generated for {permit}.
     *
     * Every successful call to {permit} increases ``owner``'s nonce by one. This
     * prevents a signature from being used multiple times.
     */
    function nonces(address owner) external view returns (uint256);

    /**
     * @dev Returns the domain separator used in the encoding of the signature for {permit}, as defined by {EIP712}.
     */
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

// lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol

// OpenZeppelin Contracts (last updated v5.0.0) (utils/ReentrancyGuard.sol)

/**
 * @dev Contract module that helps prevent reentrant calls to a function.
 *
 * Inheriting from `ReentrancyGuard` will make the {nonReentrant} modifier
 * available, which can be applied to functions to make sure there are no nested
 * (reentrant) calls to them.
 *
 * Note that because there is a single `nonReentrant` guard, functions marked as
 * `nonReentrant` may not call one another. This can be worked around by making
 * those functions `private`, and then adding `external` `nonReentrant` entry
 * points to them.
 *
 * TIP: If you would like to learn more about reentrancy and alternative ways
 * to protect against it, check out our blog post
 * https://blog.openzeppelin.com/reentrancy-after-istanbul/[Reentrancy After Istanbul].
 */
abstract contract ReentrancyGuard {
    // Booleans are more expensive than uint256 or any type that takes up a full
    // word because each write operation emits an extra SLOAD to first read the
    // slot's contents, replace the bits taken up by the boolean, and then write
    // back. This is the compiler's defense against contract upgrades and
    // pointer aliasing, and it cannot be disabled.

    // The values being non-zero value makes deployment a bit more expensive,
    // but in exchange the refund on every call to nonReentrant will be lower in
    // amount. Since refunds are capped to a percentage of the total
    // transaction's gas, it is best to keep them low in cases like this one, to
    // increase the likelihood of the full refund coming into effect.
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;

    uint256 private _status;

    /**
     * @dev Unauthorized reentrant call.
     */
    error ReentrancyGuardReentrantCall();

    constructor() {
        _status = NOT_ENTERED;
    }

    /**
     * @dev Prevents a contract from calling itself, directly or indirectly.
     * Calling a `nonReentrant` function from another `nonReentrant`
     * function is not supported. It is possible to prevent this from happening
     * by making the `nonReentrant` function external, and making it call a
     * `private` function that does the actual work.
     */
    modifier nonReentrant() {
        _nonReentrantBefore();
        _;
        _nonReentrantAfter();
    }

    function _nonReentrantBefore() private {
        // On the first call to nonReentrant, _status will be NOT_ENTERED
        if (_status == ENTERED) {
            revert ReentrancyGuardReentrantCall();
        }

        // Any calls to nonReentrant after this point will fail
        _status = ENTERED;
    }

    function _nonReentrantAfter() private {
        // By storing the original value once again, a refund is triggered (see
        // https://eips.ethereum.org/EIPS/eip-2200)
        _status = NOT_ENTERED;
    }

    /**
     * @dev Returns true if the reentrancy guard is currently set to "entered", which indicates there is a
     * `nonReentrant` function in the call stack.
     */
    function _reentrancyGuardEntered() internal view returns (bool) {
        return _status == ENTERED;
    }
}

// lib/openzeppelin-contracts/contracts/access/Ownable.sol

// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable.sol)

/**
 * @dev Contract module which provides a basic access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is set to the address provided by the deployer. This can
 * later be changed with {transferOwnership}.
 *
 * This module is used through inheritance. It will make available the modifier
 * `onlyOwner`, which can be applied to your functions to restrict their use to
 * the owner.
 */
abstract contract Ownable is Context {
    address private _owner;

    /**
     * @dev The caller account is not authorized to perform an operation.
     */
    error OwnableUnauthorizedAccount(address account);

    /**
     * @dev The owner is not a valid owner account. (eg. `address(0)`)
     */
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Initializes the contract setting the address provided by the deployer as the initial owner.
     */
    constructor(address initialOwner) {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /**
     * @dev Returns the address of the current owner.
     */
    function owner() public view virtual returns (address) {
        return _owner;
    }

    /**
     * @dev Throws if the sender is not the owner.
     */
    function _checkOwner() internal view virtual {
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    /**
     * @dev Leaves the contract without owner. It will not be possible to call
     * `onlyOwner` functions. Can only be called by the current owner.
     *
     * NOTE: Renouncing ownership will leave the contract without an owner,
     * thereby disabling any functionality that is only available to the owner.
     */
    function renounceOwnership() public virtual onlyOwner {
        _transferOwnership(address(0));
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual {
        address oldOwner = _owner;
        _owner = newOwner;
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}

// lib/openzeppelin-contracts/contracts/access/Ownable2Step.sol

// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable2Step.sol)

/**
 * @dev Contract module which provides access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is specified at deployment time in the constructor for `Ownable`. This
 * can later be changed with {transferOwnership} and {acceptOwnership}.
 *
 * This module is used through inheritance. It will make available all functions
 * from parent (Ownable).
 */
abstract contract Ownable2Step is Ownable {
    address private _pendingOwner;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Returns the address of the pending owner.
     */
    function pendingOwner() public view virtual returns (address) {
        return _pendingOwner;
    }

    /**
     * @dev Starts the ownership transfer of the contract to a new account. Replaces the pending transfer if there is one.
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner(), newOwner);
    }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`) and deletes any pending owner.
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual override {
        delete _pendingOwner;
        super._transferOwnership(newOwner);
    }

    /**
     * @dev The new owner accepts the ownership transfer.
     */
    function acceptOwnership() public virtual {
        address sender = _msgSender();
        if (pendingOwner() != sender) {
            revert OwnableUnauthorizedAccount(sender);
        }
        _transferOwnership(sender);
    }
}

// lib/openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol

// OpenZeppelin Contracts (last updated v5.0.0) (token/ERC20/utils/SafeERC20.sol)

/**
 * @title SafeERC20
 * @dev Wrappers around ERC20 operations that throw on failure (when the token
 * contract returns false). Tokens that return no value (and instead revert or
 * throw on failure) are also supported, non-reverting calls are assumed to be
 * successful.
 * To use this library you can add a `using SafeERC20 for IERC20;` statement to your contract,
 * which allows you to call the safe operations as `token.safeTransfer(...)`, etc.
 */
library SafeERC20 {
    using Address for address;

    /**
     * @dev An operation with an ERC20 token failed.
     */
    error SafeERC20FailedOperation(address token);

    /**
     * @dev Indicates a failed `decreaseAllowance` request.
     */
    error SafeERC20FailedDecreaseAllowance(address spender, uint256 currentAllowance, uint256 requestedDecrease);

    /**
     * @dev Transfer `value` amount of `token` from the calling contract to `to`. If `token` returns no value,
     * non-reverting calls are assumed to be successful.
     */
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transfer, (to, value)));
    }

    /**
     * @dev Transfer `value` amount of `token` from `from` to `to`, spending the approval given by `from` to the
     * calling contract. If `token` returns no value, non-reverting calls are assumed to be successful.
     */
    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeCall(token.transferFrom, (from, to, value)));
    }

    /**
     * @dev Increase the calling contract's allowance toward `spender` by `value`. If `token` returns no value,
     * non-reverting calls are assumed to be successful.
     */
    function safeIncreaseAllowance(IERC20 token, address spender, uint256 value) internal {
        uint256 oldAllowance = token.allowance(address(this), spender);
        forceApprove(token, spender, oldAllowance + value);
    }

    /**
     * @dev Decrease the calling contract's allowance toward `spender` by `requestedDecrease`. If `token` returns no
     * value, non-reverting calls are assumed to be successful.
     */
    function safeDecreaseAllowance(IERC20 token, address spender, uint256 requestedDecrease) internal {
        unchecked {
            uint256 currentAllowance = token.allowance(address(this), spender);
            if (currentAllowance < requestedDecrease) {
                revert SafeERC20FailedDecreaseAllowance(spender, currentAllowance, requestedDecrease);
            }
            forceApprove(token, spender, currentAllowance - requestedDecrease);
        }
    }

    /**
     * @dev Set the calling contract's allowance toward `spender` to `value`. If `token` returns no value,
     * non-reverting calls are assumed to be successful. Meant to be used with tokens that require the approval
     * to be set to zero before setting it to a non-zero value, such as USDT.
     */
    function forceApprove(IERC20 token, address spender, uint256 value) internal {
        bytes memory approvalCall = abi.encodeCall(token.approve, (spender, value));

        if (!_callOptionalReturnBool(token, approvalCall)) {
            _callOptionalReturn(token, abi.encodeCall(token.approve, (spender, 0)));
            _callOptionalReturn(token, approvalCall);
        }
    }

    /**
     * @dev Imitates a Solidity high-level call (i.e. a regular function call to a contract), relaxing the requirement
     * on the return value: the return value is optional (but if data is returned, it must not be false).
     * @param token The token targeted by the call.
     * @param data The call data (encoded using abi.encode or one of its variants).
     */
    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        // We need to perform a low level call here, to bypass Solidity's return data size checking mechanism, since
        // we're implementing it ourselves. We use {Address-functionCall} to perform this call, which verifies that
        // the target address contains contract code and also asserts for success in the low-level call.

        bytes memory returndata = address(token).functionCall(data);
        if (returndata.length != 0 && !abi.decode(returndata, (bool))) {
            revert SafeERC20FailedOperation(address(token));
        }
    }

    /**
     * @dev Imitates a Solidity high-level call (i.e. a regular function call to a contract), relaxing the requirement
     * on the return value: the return value is optional (but if data is returned, it must not be false).
     * @param token The token targeted by the call.
     * @param data The call data (encoded using abi.encode or one of its variants).
     *
     * This is a variant of {_callOptionalReturn} that silents catches all reverts and returns a bool instead.
     */
    function _callOptionalReturnBool(IERC20 token, bytes memory data) private returns (bool) {
        // We need to perform a low level call here, to bypass Solidity's return data size checking mechanism, since
        // we're implementing it ourselves. We cannot use {Address-functionCall} here since this should return false
        // and not revert is the subcall reverts.

        (bool success, bytes memory returndata) = address(token).call(data);
        return success && (returndata.length == 0 || abi.decode(returndata, (bool))) && address(token).code.length > 0;
    }
}

// src/PitchTerminalAccess.sol

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
///              **This is an explicit allow-list of known unrecoverable targets, NOT
///              a universal dead-address filter.** Other burn-like addresses
///              (e.g. `0x000…0dead`, other ERC20 contract addresses, well-known
///              treasury holes) are NOT filtered on-chain — they will receive the
///              referrer share normally. The UI/backend layer is responsible for
///              validating referrer links before promoting them to users.
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

