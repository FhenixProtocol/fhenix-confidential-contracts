// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC7984Receiver } from "../interfaces/IERC7984Receiver.sol";
import { ebool, euint64, sharedEbool, sharedEuint64, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @dev The wrapper's `unshield` overload this attacker re-enters.
interface IReentrantUnshield {
    function unshield(address from, address to, sharedEuint64 sharedAmount) external returns (sharedEuint64);
}

/**
 * @dev Test-only attacker probing the SECOND re-entrancy vector of the FHERC20
 * `*AndCall` flow on a wrapper: instead of sweeping via `confidentialTransfer`,
 * it re-enters `unshield` to burn its just-credited balance into a pending claim
 * for `attacker`, then returns `false` to request a refund.
 *
 * Without the reentrancy guard the refund's saturating `tryDecrease` would find a
 * zero balance (already burned) and no-op, so the sender is debited AND the
 * attacker walks away with a claim on the wrapper's underlying. The `nonReentrant`
 * guard on `unshield` makes the re-entrant call revert, which bubbles up through
 * the receiver callback and reverts the whole transfer.
 */
contract MaliciousUnshieldReceiver is IERC7984Receiver {
    address public immutable attacker;
    bool public reentered;

    constructor(address _attacker) {
        attacker = _attacker;
    }

    function onConfidentialTransferReceived(
        address /* operator */,
        address /* from */,
        sharedEuint64 sharedAmount,
        bytes calldata /* data */
    ) external returns (sharedEbool) {
        // Unwrap the directed share. Requires the sharer to be `msg.sender` (the token), so an
        // arbitrary caller cannot reach this callback with a handle nobody shared.
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        // The forward leg already credited us `amount` and granted us ACL on the
        // handle, so we can unshield it right now — before the refund leg runs.
        if (!reentered) {
            reentered = true;
            IReentrantUnshield(msg.sender).unshield(address(this), attacker, FHE.shareEuint64(amount, msg.sender));
        }

        ebool rejected = FHE.asEbool(false);
        return FHE.shareEbool(rejected, msg.sender);
    }
}
