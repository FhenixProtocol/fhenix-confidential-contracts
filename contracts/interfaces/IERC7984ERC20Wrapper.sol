// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Interface for an {ERC7984} wrapper that shields an underlying ERC-20 token into a
 * confidential {ERC7984} token. Users `shield` their ERC-20 tokens to receive confidential
 * tokens, and `unshield` to burn them and reclaim the underlying.
 *
 * The unshield flow is asynchronous: `unshield` burns the confidential tokens and creates a
 * decrypt request, then `claimUnshielded` verifies the decryption proof and transfers
 * the underlying tokens.
 */
interface IERC7984ERC20Wrapper {
    /// @dev Emitted when an unshield request is created.
    event Unshielded(address indexed to, bytes32 indexed unshieldRequestId, euint64 unshieldAmount);

    /// @dev Emitted when an unshield request is claimed (underlying tokens transferred).
    event ClaimedUnshielded(
        address indexed to,
        bytes32 indexed unshieldRequestId,
        euint64 indexed unshieldAmount,
        uint64 unshieldAmountCleartext
    );

    /**
     * @dev Shields `amount` of the underlying ERC-20 token and mints confidential tokens to `to`.
     * The amount is rounded down to the nearest multiple of {rate} to fit confidential precision.
     *
     * Returns the encrypted amount of shielded tokens sent.
     */
    function shield(address to, uint256 amount) external returns (euint64);

    /**
     * @dev Initiates an unshield of confidential tokens from `from` and creates a pending unshield
     * request for `to`. The caller must be `from` or an operator for `from`.
     *
     * Returns the unshield request ID (the cipher-text handle of the burned amount).
     */
    function unshield(address from, address to, euint64 amount) external returns (bytes32);

    /**
     * @dev Similar to {unshield-address-address-euint64} but accepts an encrypted input with proof.
     */
    function unshield(address from, address to, InEuint64 memory encryptedAmount) external returns (bytes32);

    /**
     * @dev Claims a pending unshield request by verifying the decryption proof and transferring
     * `unshieldAmountCleartext * rate()` underlying tokens to the requester.
     */
    function claimUnshielded(
        bytes32 unshieldRequestId,
        uint64 unshieldAmountCleartext,
        bytes calldata decryptionProof
    ) external;

    /// @dev Returns the conversion rate between the underlying ERC-20 denomination and confidential precision.
    function rate() external view returns (uint256);

    /// @dev Returns the address of the underlying ERC-20 token.
    function underlying() external view returns (address);

    /// @dev Returns the encrypted amount associated with a given unshield request ID.
    function unshieldAmount(bytes32 unshieldRequestId) external view returns (euint64);

    /// @dev Returns the recipient address for a given unshield request ID, or `address(0)` if none exists.
    function unshieldRequester(bytes32 unshieldRequestId) external view returns (address);
}
