// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/**
 * @dev Test-only ETH recipient that re-enters the paying contract from `receive()` and RECORDS
 * what happened instead of propagating it.
 *
 * Recording rather than reverting is the point. The wrapper pays a claim with a raw
 * `call{value:}` and turns any failure into `NativeTransferFailed`, so a probe that reverted
 * would mask the inner reason and the test could not tell a reentrancy guard from a bad claim id.
 * Here the outer payout succeeds and the test inspects `lastSuccess` / `lastReturnData`, which
 * distinguishes `ReentrancyGuardReentrantCall()` (guard held) from `ClaimNotFound()` (no guard,
 * call proceeded to the claim lookup) by selector.
 */
contract ReentrancyProbeReceiver {
    address public armedTarget;
    bytes public payload;
    bool public fired;

    bool public lastSuccess;
    bytes public lastReturnData;

    /// @dev Arms the call made from inside `receive()`. Unarmed, this is an ordinary EOA-like sink.
    function arm(address target_, bytes calldata payload_) external {
        armedTarget = target_;
        payload = payload_;
        fired = false;
    }

    receive() external payable {
        if (fired || armedTarget == address(0)) return;
        fired = true;
        (bool ok, bytes memory ret) = armedTarget.call(payload);
        lastSuccess = ok;
        lastReturnData = ret;
    }
}
