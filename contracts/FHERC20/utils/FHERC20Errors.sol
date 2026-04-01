// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @dev The given receiver `receiver` is invalid for transfers.
error FHERC20InvalidReceiver(address receiver);

/// @dev The given sender `sender` is invalid for transfers.
error FHERC20InvalidSender(address sender);

/// @dev The given holder `holder` is not authorized to spend on behalf of `spender`.
error FHERC20UnauthorizedSpender(address holder, address spender);

/// @dev The holder `holder` is trying to send tokens but has a balance of 0.
error FHERC20ZeroBalance(address holder);

/**
 * @dev The caller `user` does not have access to the encrypted amount `amount`.
 *
 * NOTE: Try using the equivalent transfer function with an input proof.
 */
error FHERC20UnauthorizedUseOfEncryptedAmount(euint64 amount, address user);

/// @dev The given caller `caller` is not authorized for the current operation.
error FHERC20UnauthorizedCaller(address caller);

/// @dev Reverts when a cleartext ERC-20 function is called on a confidential token.
error FHERC20IncompatibleFunction();
