// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC7984Receiver } from "../interfaces/IERC7984Receiver.sol";
import { ebool, sharedEbool, sharedEuint64, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Test-only receiver for Consensys Diligence 5.16: it moves its OWN confidential balance
 * during its transfer callback, then answers accept or reject as configured.
 *
 * The point of the finding is that the rejection refund is a saturating debit against a balance
 * the recipient controls, so a recipient that empties itself mid-callback keeps the funds AND
 * signals rejection. Every `confidentialTransfer*` and `unshield` entry point is `nonReentrant`,
 * so the sweep in {MaliciousReentrantReceiver} cannot land — this mock instead reaches an
 * UNGUARDED balance-moving path (a harness `burn`, or the production `shield`), which is exactly
 * the future footgun the handle check in `_transferAndCall` / `_moveAndCall` exists to catch.
 */
contract CallbackBalanceMover is IERC7984Receiver {
    address public armedTarget;
    bytes public payload;
    bool public immutable accept;
    bool public fired;

    constructor(bool accept_) {
        accept = accept_;
    }

    /// @dev Arms the call this receiver makes from inside its callback. Unarmed, it moves nothing.
    function arm(address target_, bytes calldata payload_) external {
        armedTarget = target_;
        payload = payload_;
    }

    function onConfidentialTransferReceived(
        address,
        address,
        sharedEuint64,
        bytes calldata
    ) external returns (sharedEbool) {
        if (!fired && armedTarget != address(0)) {
            fired = true;
            (bool ok, bytes memory ret) = armedTarget.call(payload);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
        }

        ebool returnVal = FHE.asEbool(accept);
        return FHE.shareEbool(returnVal, msg.sender);
    }
}
