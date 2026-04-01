// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Interface for an {FHERC20} wrapper that shields an underlying ERC-20 token into a
 * confidential {FHERC20} token. Users `shield` their ERC-20 tokens to receive confidential
 * tokens, and `unshield` to burn them and reclaim the underlying.
 *
 * The unshield flow is asynchronous: `unshield` burns the confidential tokens and creates a
 * decrypt request, then `claimUnshielded` verifies the decryption proof and transfers
 * the underlying tokens.
 */
interface IFHERC20ERC20Wrapper {
    /// @dev Emitted when an unshield request is created.
    event Unshielded(address indexed to, euint64 indexed amount);

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
     * Returns the encrypted amount that was burned.
     */
    function unshield(address from, address to, uint64 amount) external returns (euint64);

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
}
