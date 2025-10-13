// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IFHERC20Receiver } from "../interfaces/IFHERC20Receiver.sol";
import { ebool, euint64, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Mock contract to test FHERC20 receiver callback functionality
 */
contract MockFHERC20Receiver is IFHERC20Receiver {
    event ConfidentialTransferCallback(bool success);

    error InvalidInput(uint8 input);

    /// Data should contain a success boolean (plaintext). Revert if not.
    function onConfidentialTransferReceived(address, address, euint64, bytes calldata data) external returns (ebool) {
        uint8 input = abi.decode(data, (uint8));

        if (input > 1) revert InvalidInput(input);

        bool success = input == 1;
        emit ConfidentialTransferCallback(success);

        ebool returnVal = FHE.asEbool(success);
        FHE.allowTransient(returnVal, msg.sender);

        return returnVal;
    }
}
