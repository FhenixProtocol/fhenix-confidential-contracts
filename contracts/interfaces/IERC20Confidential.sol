// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Interface for ERC-20 tokens extended with a second, confidential (FHE-encrypted) balance layer.
 *
 * Users hold both a standard public ERC-20 balance and an encrypted `euint64` balance. The two are
 * bridged via {shield} (public -> confidential) and {unshield} / {claimUnshielded} (confidential -> public).
 *
 * The unshield flow is asynchronous: {unshield} burns confidential tokens and creates a decrypt
 * request, then {claimUnshielded} verifies the decryption proof and transfers the public tokens.
 */
interface IERC20Confidential {
    /// @dev Emitted when a confidential transfer is made from `from` to `to` of encrypted amount `amount`.
    event ConfidentialTransfer(address indexed from, address indexed to, euint64 indexed amount);

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

    /// @dev Emitted when an operator is set.
    event OperatorSet(address indexed holder, address indexed operator, uint48 until);

    /// @dev Returns the confidential balance of `account` (encrypted).
    function confidentialBalanceOf(address account) external view returns (euint64);

    /// @dev Returns the number of decimals used for the confidential (encrypted) state.
    function confidentialDecimals() external view returns (uint8);

    /// @dev Returns true if `spender` is currently an operator for `holder`.
    function isOperator(address holder, address spender) external view returns (bool);

    /**
     * @dev Transfers the encrypted amount `value` of confidential tokens to `to`.
     * The caller must already be allowed by ACL for the given `value`.
     *
     * Returns the encrypted amount that was actually transferred.
     */
    function confidentialTransfer(address to, euint64 value) external returns (euint64 transferred);

    /**
     * @dev Transfers an encrypted amount to `to` using an input proof.
     *
     * Returns the encrypted amount that was actually transferred.
     */
    function confidentialTransfer(address to, InEuint64 memory inValue) external returns (euint64 transferred);

    /**
     * @dev Transfers encrypted amount `value` from `from` to `to` (requires operator approval).
     * The caller must already be allowed by ACL for the given `value`.
     *
     * Returns the encrypted amount that was actually transferred.
     */
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 value
    ) external returns (euint64 transferred);

    /**
     * @dev Transfers an encrypted amount from `from` to `to` using an input proof (requires operator approval).
     *
     * Returns the encrypted amount that was actually transferred.
     */
    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory inValue
    ) external returns (euint64 transferred);

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
     * @dev Claims a pending unshield request by verifying the decryption proof and transferring
     * the corresponding public tokens.
     */
    function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes calldata decryptionProof) external;

    /**
     * @dev Sets `operator` as an operator for the caller until timestamp `until`.
     */
    function setOperator(address operator, uint48 until) external;
}
