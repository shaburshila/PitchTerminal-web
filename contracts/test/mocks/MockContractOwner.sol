// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

/// @title MockContractOwner
/// @notice Minimal contract that can stand in as the `owner` of an
///         `Ownable2Step` contract. Production owners will typically be a Safe
///         multisig; this stub validates that the contract-as-owner path works
///         end-to-end (pending owner can accept ownership via `call`).
contract MockContractOwner {
    /// @notice Generic forwarder so tests can call any function on a target as
    ///         if the call came from this contract.
    function call(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "MockContractOwner: call failed");
        return ret;
    }
}
