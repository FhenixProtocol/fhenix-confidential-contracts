// SPDX-License-Identifier: MIT
// OpenZeppelin Confidential Contracts (last updated v0.2.0) (token/utils/ConfidentialFungibleTokenUtils.sol)
pragma solidity ^0.8.25;

import { euint64, ebool, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import { IFHERC20Receiver } from "../interfaces/IFHERC20Receiver.sol";
import { IFHERC20Errors } from "../interfaces/IFHERC20Errors.sol";
import { FHERC20 } from "../FHERC20.sol";

library FHERC20Utils {
    /**
     * @dev Performs a transfer callback to the recipient of the transfer `to`. Should be invoked
     * after all transfers "withCallback" on a {FHERC20}.
     *
     * The transfer callback is not invoked on the recipient if the recipient has no code (i.e. is an EOA). If the
     * recipient has non-zero code, it must implement
     * {FHERC20Receiver-onConfidentialTransferReceived} and return an `ebool` indicating
     * whether the transfer was accepted or not. If the `ebool` is `false`, the transfer will be reversed.
     */
    function checkOnTransferReceived(
        address operator,
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) internal returns (ebool) {
        if (to.code.length > 0) {
            try IFHERC20Receiver(to).onConfidentialTransferReceived(operator, from, amount, data) returns (
                ebool retval
            ) {
                return retval;
            } catch (bytes memory reason) {
                if (reason.length == 0) {
                    revert IFHERC20Errors.FHERC20InvalidReceiver(to);
                } else {
                    assembly ("memory-safe") {
                        revert(add(32, reason), mload(reason))
                    }
                }
            }
        } else {
            return FHE.asEbool(true);
        }
    }
}
