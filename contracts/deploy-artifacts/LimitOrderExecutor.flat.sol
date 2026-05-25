// SPDX-License-Identifier: MIT
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

// lib/openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol

// OpenZeppelin Contracts (last updated v5.0.0) (utils/cryptography/ECDSA.sol)

/**
 * @dev Elliptic Curve Digital Signature Algorithm (ECDSA) operations.
 *
 * These functions can be used to verify that a message was signed by the holder
 * of the private keys of a given address.
 */
library ECDSA {
    enum RecoverError {
        NoError,
        InvalidSignature,
        InvalidSignatureLength,
        InvalidSignatureS
    }

    /**
     * @dev The signature derives the `address(0)`.
     */
    error ECDSAInvalidSignature();

    /**
     * @dev The signature has an invalid length.
     */
    error ECDSAInvalidSignatureLength(uint256 length);

    /**
     * @dev The signature has an S value that is in the upper half order.
     */
    error ECDSAInvalidSignatureS(bytes32 s);

    /**
     * @dev Returns the address that signed a hashed message (`hash`) with `signature` or an error. This will not
     * return address(0) without also returning an error description. Errors are documented using an enum (error type)
     * and a bytes32 providing additional information about the error.
     *
     * If no error is returned, then the address can be used for verification purposes.
     *
     * The `ecrecover` EVM precompile allows for malleable (non-unique) signatures:
     * this function rejects them by requiring the `s` value to be in the lower
     * half order, and the `v` value to be either 27 or 28.
     *
     * IMPORTANT: `hash` _must_ be the result of a hash operation for the
     * verification to be secure: it is possible to craft signatures that
     * recover to arbitrary addresses for non-hashed data. A safe way to ensure
     * this is by receiving a hash of the original message (which may otherwise
     * be too long), and then calling {MessageHashUtils-toEthSignedMessageHash} on it.
     *
     * Documentation for signature generation:
     * - with https://web3js.readthedocs.io/en/v1.3.4/web3-eth-accounts.html#sign[Web3.js]
     * - with https://docs.ethers.io/v5/api/signer/#Signer-signMessage[ethers]
     */
    function tryRecover(bytes32 hash, bytes memory signature) internal pure returns (address, RecoverError, bytes32) {
        if (signature.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            // ecrecover takes the signature parameters, and the only way to get them
            // currently is to use assembly.
            /// @solidity memory-safe-assembly
            assembly {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
                v := byte(0, mload(add(signature, 0x60)))
            }
            return tryRecover(hash, v, r, s);
        } else {
            return (address(0), RecoverError.InvalidSignatureLength, bytes32(signature.length));
        }
    }

    /**
     * @dev Returns the address that signed a hashed message (`hash`) with
     * `signature`. This address can then be used for verification purposes.
     *
     * The `ecrecover` EVM precompile allows for malleable (non-unique) signatures:
     * this function rejects them by requiring the `s` value to be in the lower
     * half order, and the `v` value to be either 27 or 28.
     *
     * IMPORTANT: `hash` _must_ be the result of a hash operation for the
     * verification to be secure: it is possible to craft signatures that
     * recover to arbitrary addresses for non-hashed data. A safe way to ensure
     * this is by receiving a hash of the original message (which may otherwise
     * be too long), and then calling {MessageHashUtils-toEthSignedMessageHash} on it.
     */
    function recover(bytes32 hash, bytes memory signature) internal pure returns (address) {
        (address recovered, RecoverError error, bytes32 errorArg) = tryRecover(hash, signature);
        _throwError(error, errorArg);
        return recovered;
    }

    /**
     * @dev Overload of {ECDSA-tryRecover} that receives the `r` and `vs` short-signature fields separately.
     *
     * See https://eips.ethereum.org/EIPS/eip-2098[EIP-2098 short signatures]
     */
    function tryRecover(bytes32 hash, bytes32 r, bytes32 vs) internal pure returns (address, RecoverError, bytes32) {
        unchecked {
            bytes32 s = vs & bytes32(0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff);
            // We do not check for an overflow here since the shift operation results in 0 or 1.
            uint8 v = uint8((uint256(vs) >> 255) + 27);
            return tryRecover(hash, v, r, s);
        }
    }

    /**
     * @dev Overload of {ECDSA-recover} that receives the `r and `vs` short-signature fields separately.
     */
    function recover(bytes32 hash, bytes32 r, bytes32 vs) internal pure returns (address) {
        (address recovered, RecoverError error, bytes32 errorArg) = tryRecover(hash, r, vs);
        _throwError(error, errorArg);
        return recovered;
    }

    /**
     * @dev Overload of {ECDSA-tryRecover} that receives the `v`,
     * `r` and `s` signature fields separately.
     */
    function tryRecover(
        bytes32 hash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal pure returns (address, RecoverError, bytes32) {
        // EIP-2 still allows signature malleability for ecrecover(). Remove this possibility and make the signature
        // unique. Appendix F in the Ethereum Yellow paper (https://ethereum.github.io/yellowpaper/paper.pdf), defines
        // the valid range for s in (301): 0 < s < secp256k1n ÷ 2 + 1, and for v in (302): v ∈ {27, 28}. Most
        // signatures from current libraries generate a unique signature with an s-value in the lower half order.
        //
        // If your library generates malleable signatures, such as s-values in the upper range, calculate a new s-value
        // with 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - s1 and flip v from 27 to 28 or
        // vice versa. If your library also generates signatures with 0/1 for v instead 27/28, add 27 to v to accept
        // these malleable signatures as well.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return (address(0), RecoverError.InvalidSignatureS, s);
        }

        // If the signature is valid (and not malleable), return the signer address
        address signer = ecrecover(hash, v, r, s);
        if (signer == address(0)) {
            return (address(0), RecoverError.InvalidSignature, bytes32(0));
        }

        return (signer, RecoverError.NoError, bytes32(0));
    }

    /**
     * @dev Overload of {ECDSA-recover} that receives the `v`,
     * `r` and `s` signature fields separately.
     */
    function recover(bytes32 hash, uint8 v, bytes32 r, bytes32 s) internal pure returns (address) {
        (address recovered, RecoverError error, bytes32 errorArg) = tryRecover(hash, v, r, s);
        _throwError(error, errorArg);
        return recovered;
    }

    /**
     * @dev Optionally reverts with the corresponding custom error according to the `error` argument provided.
     */
    function _throwError(RecoverError error, bytes32 errorArg) private pure {
        if (error == RecoverError.NoError) {
            return; // no error: do nothing
        } else if (error == RecoverError.InvalidSignature) {
            revert ECDSAInvalidSignature();
        } else if (error == RecoverError.InvalidSignatureLength) {
            revert ECDSAInvalidSignatureLength(uint256(errorArg));
        } else if (error == RecoverError.InvalidSignatureS) {
            revert ECDSAInvalidSignatureS(errorArg);
        }
    }
}

// lib/openzeppelin-contracts/contracts/interfaces/IERC1271.sol

// OpenZeppelin Contracts (last updated v5.0.0) (interfaces/IERC1271.sol)

/**
 * @dev Interface of the ERC1271 standard signature validation method for
 * contracts as defined in https://eips.ethereum.org/EIPS/eip-1271[ERC-1271].
 */
interface IERC1271 {
    /**
     * @dev Should return whether the signature provided is valid for the provided data
     * @param hash      Hash of the data to be signed
     * @param signature Signature byte array associated with _data
     */
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4 magicValue);
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

// src/interfaces/IHook.sol

/// @title IHook — pitchwc bonding-curve hook interface (player and country).
/// @notice Mirrors the on-chain pitchwc Hook surface used by
///         `LimitOrderExecutor` (price read) and by the frontend trade panel
///         (live quotes). Signatures match `docs/eip712.md` §4 and the
///         `currentPrice(address)` selector exercised in
///         `backend/worker/price_loop.py`.
/// @dev All amounts and prices use 18-decimal fixed-point. `currentPrice` is
///      fee-excluded (the chart price); `quoteBuy`/`quoteSell` include the
///      pitchwc 5% protocol fee.
interface IHook {
    /// @notice Current mid price of `token` in quote-wei per 1 whole base.
    ///         For player tokens quote = country token; for country tokens
    ///         quote = PITCH. See `docs/eip712.md` §1.
    function currentPrice(address token) external view returns (uint256);

    /// @notice Quote: spending `quoteIn` wei of the quote token yields how
    ///         many wei of `token` (fee-inclusive).
    function quoteBuy(address token, uint256 quoteIn) external view returns (uint256 baseOut);

    /// @notice Quote: selling `baseIn` wei of `token` yields how many wei of
    ///         the quote token (fee-inclusive).
    function quoteSell(address token, uint256 baseIn) external view returns (uint256 quoteOut);
}

// src/interfaces/IRouter.sol

/// @title IRouter — pitchwc swap router interface (player and country).
/// @notice Mirrors the pitchwc Router surface invoked by `LimitOrderExecutor`
///         in the swap step. Signatures match `docs/eip712.md` §6 reference
///         flow and the inline ABI in `frontend/src/trade-panel.js`
///         (`buy(address,uint256,uint256)` / `sell(address,uint256,uint256)`).
/// @dev The router pulls the input token from `msg.sender` via
///      `transferFrom` and pushes the output token back to `msg.sender`.
///      For player venue the input on `buy` is the country token of `token`;
///      for country venue the input on `buy` is PITCH.
interface IRouter {
    /// @notice Buy `token` by spending `amountIn` wei of the appropriate
    ///         quote token. Reverts if the realised out is below `minOut`.
    /// @return amountOut wei of `token` received by `msg.sender`.
    function buy(address token, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);

    /// @notice Sell `amountIn` wei of `token` for the appropriate quote
    ///         token. Reverts if the realised out is below `minOut`.
    /// @return amountOut wei of quote token received by `msg.sender`.
    function sell(address token, uint256 amountIn, uint256 minOut)
        external
        returns (uint256 amountOut);
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

// lib/openzeppelin-contracts/contracts/utils/Pausable.sol

// OpenZeppelin Contracts (last updated v5.0.0) (utils/Pausable.sol)

/**
 * @dev Contract module which allows children to implement an emergency stop
 * mechanism that can be triggered by an authorized account.
 *
 * This module is used through inheritance. It will make available the
 * modifiers `whenNotPaused` and `whenPaused`, which can be applied to
 * the functions of your contract. Note that they will not be pausable by
 * simply including this module, only once the modifiers are put in place.
 */
abstract contract Pausable is Context {
    bool private _paused;

    /**
     * @dev Emitted when the pause is triggered by `account`.
     */
    event Paused(address account);

    /**
     * @dev Emitted when the pause is lifted by `account`.
     */
    event Unpaused(address account);

    /**
     * @dev The operation failed because the contract is paused.
     */
    error EnforcedPause();

    /**
     * @dev The operation failed because the contract is not paused.
     */
    error ExpectedPause();

    /**
     * @dev Initializes the contract in unpaused state.
     */
    constructor() {
        _paused = false;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is not paused.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     */
    modifier whenNotPaused() {
        _requireNotPaused();
        _;
    }

    /**
     * @dev Modifier to make a function callable only when the contract is paused.
     *
     * Requirements:
     *
     * - The contract must be paused.
     */
    modifier whenPaused() {
        _requirePaused();
        _;
    }

    /**
     * @dev Returns true if the contract is paused, and false otherwise.
     */
    function paused() public view virtual returns (bool) {
        return _paused;
    }

    /**
     * @dev Throws if the contract is paused.
     */
    function _requireNotPaused() internal view virtual {
        if (paused()) {
            revert EnforcedPause();
        }
    }

    /**
     * @dev Throws if the contract is not paused.
     */
    function _requirePaused() internal view virtual {
        if (!paused()) {
            revert ExpectedPause();
        }
    }

    /**
     * @dev Triggers stopped state.
     *
     * Requirements:
     *
     * - The contract must not be paused.
     */
    function _pause() internal virtual whenNotPaused {
        _paused = true;
        emit Paused(_msgSender());
    }

    /**
     * @dev Returns to normal state.
     *
     * Requirements:
     *
     * - The contract must be paused.
     */
    function _unpause() internal virtual whenPaused {
        _paused = false;
        emit Unpaused(_msgSender());
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

// lib/openzeppelin-contracts/contracts/utils/cryptography/SignatureChecker.sol

// OpenZeppelin Contracts (last updated v5.0.0) (utils/cryptography/SignatureChecker.sol)

/**
 * @dev Signature verification helper that can be used instead of `ECDSA.recover` to seamlessly support both ECDSA
 * signatures from externally owned accounts (EOAs) as well as ERC1271 signatures from smart contract wallets like
 * Argent and Safe Wallet (previously Gnosis Safe).
 */
library SignatureChecker {
    /**
     * @dev Checks if a signature is valid for a given signer and data hash. If the signer is a smart contract, the
     * signature is validated against that smart contract using ERC1271, otherwise it's validated using `ECDSA.recover`.
     *
     * NOTE: Unlike ECDSA signatures, contract signatures are revocable, and the outcome of this function can thus
     * change through time. It could return true at block N and false at block N+1 (or the opposite).
     */
    function isValidSignatureNow(address signer, bytes32 hash, bytes memory signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError error, ) = ECDSA.tryRecover(hash, signature);
        return
            (error == ECDSA.RecoverError.NoError && recovered == signer) ||
            isValidERC1271SignatureNow(signer, hash, signature);
    }

    /**
     * @dev Checks if a signature is valid for a given signer and data hash. The signature is validated
     * against the signer smart contract using ERC1271.
     *
     * NOTE: Unlike ECDSA signatures, contract signatures are revocable, and the outcome of this function can thus
     * change through time. It could return true at block N and false at block N+1 (or the opposite).
     */
    function isValidERC1271SignatureNow(
        address signer,
        bytes32 hash,
        bytes memory signature
    ) internal view returns (bool) {
        (bool success, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (hash, signature))
        );
        return (success &&
            result.length >= 32 &&
            abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector));
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

// src/LimitOrderExecutor.sol

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
///         Token assumption: all tokens traded through this executor (PITCH,
///         country tokens, player tokens) are assumed to be standard ERC20:
///         no fee-on-transfer, no rebasing, no reentrant ERC777-style callbacks.
///         Fee-on-transfer tokens would cause self-DoS (router receives less
///         than approved) but cannot lead to fund loss.
///         Sub-dust amountIn: when `amountIn * 1e18 < targetPrice`, `_minOut`
///         rounds to zero, leaving slippage protection at the router level only.
///         UI/backend MUST reject sub-dust orders before signing.
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
            // `livePrice == 0` is rejected explicitly: a buggy / mis-registered
            // hook returning 0 would otherwise satisfy `0 > target == false` and
            // let the order execute against an unpriced token. (take-profit is
            // symmetrically safe because `0 < target` is true → reverts.)
            if (livePrice == 0 || livePrice > order.targetPrice) revert PriceConditionNotMet();
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

