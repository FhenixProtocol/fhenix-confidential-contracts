// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (interfaces/draft-IERC6093.sol)
pragma solidity ^0.8.25;

import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Standard FHERC-20 Errors
 * Interface of the https://eips.ethereum.org/EIPS/eip-6093[ERC-6093] custom errors for ERC-20 tokens.
 */
interface IFHERC20Errors is IERC20Errors {
    /**
     * @dev Indicates an incompatible function being called.
     * Prevents unintentional treatment of an FHERC20 as a cleartext ERC20
     */
    error FHERC20IncompatibleFunction();

    /// @dev The given receiver `receiver` is invalid for transfers.
    error FHERC20InvalidReceiver(address receiver);

    /**
     * @dev ConfidentialTransferFrom `from` and `permit.owner` don't match
     * @param from ConfidentialTransferFrom param.
     * @param permitOwner token owner included in FHERC20_EIP712_Permit struct.
     */
    error FHERC20ConfidentialTransferFromOwnerMismatch(address from, address permitOwner);

    /**
     * @dev The caller `owner` does not have access to the encrypted value `value`.
     *
     */
    error FHERC20UnauthorizedUseOfEncryptedAmount(euint64 value, address owner);

    /**
     * @dev ConfidentialTransferFrom `from` and `permit.owner` don't match
     * @param from ConfidentialTransferFrom param.
     * @param spender operator authorized to spent tokens from.
     */
    error FHERC20UnauthorizedSpender(address from, address spender);

    /**
     * @dev ConfidentialTransferFrom `to` and `permit.spender` don't match
     * @param to ConfidentialTransferFrom param.
     * @param permitSpender token receiver included in FHERC20_EIP712_Permit struct.
     */
    error FHERC20ConfidentialTransferFromSpenderMismatch(address to, address permitSpender);

    /**
     * @dev ConfidentialTransferFrom `value` greater than `permit.value_hash` dont match (permit doesn't match InEuint64)
     * @param inValueHash ConfidentialTransferFrom param inValue.ctHash.
     * @param permitValueHash token amount hash included in FHERC20_EIP712_Permit struct.
     */
    error FHERC20ConfidentialTransferFromValueHashMismatch(uint256 inValueHash, uint256 permitValueHash);
}
