// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IFHERC20 } from "../interfaces/IFHERC20.sol";

/**
 * @dev Interface for ERC-20 tokens extended with a second, confidential (FHE-encrypted) balance layer.
 *
 * Mirrors the {IFHERC20} surface for the confidential half of the dual-balance token. Holders have both
 * a real public ERC-20 balance and an encrypted `euint64` balance, bridged via {shield} (public ->
 * confidential) and {unshield} / {claimUnshielded} (confidential -> public).
 *
 * The unshield flow is asynchronous: {unshield} burns confidential tokens and creates a decrypt
 * request, then {claimUnshielded} verifies the decryption proof and transfers the public tokens.
 */
interface IERC20Confidential is IFHERC20 {
    /// @dev Emitted when tokens are shielded (converted from public to confidential).
    event TokensShielded(address indexed account, uint256 amount);

    /// @dev Emitted when an unshield request is created.
    event TokensUnshielded(address indexed account, euint64 indexed amount);

    /// @dev Emitted when an unshield request is claimed (public tokens transferred).
    event UnshieldedTokensClaimed(
        address indexed account,
        bytes32 indexed unshieldRequestId,
        euint64 indexed unshieldAmount,
        uint64 unshieldAmountCleartext
    );

    /// @dev Returns the number of decimals used for the confidential (encrypted) state.
    function confidentialDecimals() external view returns (uint8);

    /**
     * @dev Shields `amount` public tokens into confidential tokens for the caller.
     * The amount is rounded down to the nearest multiple of the conversion rate.
     */
    function shield(uint256 amount) external;

    /**
     * @dev Initiates an unshield of `amount` confidential tokens, creating a pending claim.
     *
     * Returns the encrypted amount that was burned.
     */
    function unshield(uint64 amount) external returns (euint64);

    /**
     * @dev Initiates an unshield of an encrypted `amount` of confidential tokens, creating a
     * pending claim. The caller must have ACL access to `amount`.
     *
     * Returns the encrypted amount that was burned.
     */
    function unshield(euint64 amount) external returns (euint64);

    /**
     * @dev Claims a pending unshield request by verifying the decryption proof and transferring
     * the corresponding public tokens.
     */
    function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes calldata decryptionProof) external;
}
