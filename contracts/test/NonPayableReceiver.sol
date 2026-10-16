// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @dev Test-only stand-in for the recipient at the heart of Consensys Diligence 5.13: a contract
 * that CANNOT accept native value (no `receive`, no payable `fallback`) but CAN make outbound
 * calls.
 *
 * That combination is the realistic shape of the finding — a vault, router or account contract
 * that simply never declared a payable entry point. An unshield naming it strands the burned value
 * forever under the original code, and its ability to call is what lets it reach the two escape
 * hatches ({claimUnshieldedAsWETH} and {reassignClaim}).
 */
contract NonPayableReceiver {
    /// @dev Forwards an arbitrary call so the test can drive the wrapper as this contract.
    function execute(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }
}
