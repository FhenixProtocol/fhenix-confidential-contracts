// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC7984Receiver } from "../interfaces/IERC7984Receiver.sol";
import { ebool, sharedEbool, sharedEuint64, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Test-only receiver that answers with a handle it never SHARED with the token — the exact
 * mistake an integrator makes when the ACL obligation is undocumented (Consensys Diligence 5.30).
 *
 * It wraps a bare `ebool` as a `sharedEbool` instead of going through {FHE-shareEbool}, so no
 * share is pending when the token calls {FHE-receiveEboolFromCall}. Its purpose is to pin the
 * consequence: the transfer REVERTS, rather than the unusable answer being read as a rejection
 * and quietly triggering a refund.
 */
contract UnsharedAnswerReceiver is IERC7984Receiver {
    /// @dev `accept` is irrelevant to the outcome — the answer is unusable either way, which is
    /// the point: the obligation applies to the accept and reject paths alike.
    bool public immutable accept;

    constructor(bool accept_) {
        accept = accept_;
    }

    function onConfidentialTransferReceived(
        address,
        address,
        sharedEuint64,
        bytes calldata
    ) external returns (sharedEbool) {
        ebool answer = FHE.asEbool(accept);
        // The bug: a bare handle handed across the boundary with no share created for the token.
        return sharedEbool.wrap(ebool.unwrap(answer));
    }
}
