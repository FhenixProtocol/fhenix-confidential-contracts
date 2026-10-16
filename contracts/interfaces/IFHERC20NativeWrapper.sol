// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64, sharedEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Interface for an {FHERC20} wrapper that shields a chain's native token (e.g. ETH)
 * into a confidential {FHERC20} token.
 *
 * Two shield entry-points are provided:
 *  - {shieldWrappedNative}: pulls WETH from the caller, unwraps it, and mints confidential tokens.
 *  - {shieldNative}: accepts native value directly and mints confidential tokens.
 *
 * The unshield flow is asynchronous: {unshield} burns the confidential tokens and creates a
 * decrypt request, then {claimUnshielded} verifies the decryption proof and transfers native
 * tokens to the recipient.
 */
interface IFHERC20NativeWrapper {
    /// @dev Emitted when native or wrapped-native tokens are shielded.
    event ShieldedNative(address indexed from, address indexed to, uint256 value);

    /// @dev Emitted when an unshield request is created.
    event Unshielded(address indexed to, euint64 indexed amount);

    /// @dev Emitted when a claim is settled in WETH instead of native value, alongside the
    /// regular {ClaimedUnshielded}.
    event ClaimedUnshieldedAsWETH(address indexed to, bytes32 indexed unshieldRequestId, uint256 wethAmount);

    /// @dev Emitted when an unshield request is claimed (native tokens transferred).
    event ClaimedUnshielded(
        address indexed to,
        bytes32 indexed unshieldRequestId,
        euint64 indexed unshieldAmount,
        uint64 unshieldAmountCleartext
    );

    /**
     * @dev Shields WETH into confidential tokens. Pulls `value` WETH from the caller,
     * unwraps it to native, and mints the equivalent confidential amount. `value` is
     * truncated to the nearest multiple of {rate}; the remainder is not transferred.
     *
     * Returns the encrypted amount of shielded tokens sent.
     */
    function shieldWrappedNative(address to, uint256 value) external returns (sharedEuint64);

    /**
     * @dev Shields native tokens into confidential tokens. `msg.value` is truncated to
     * the nearest multiple of {rate}; any dust below the threshold is refunded to the caller.
     *
     * Returns the encrypted amount of shielded tokens sent.
     */
    function shieldNative(address to) external payable returns (sharedEuint64);

    /**
     * @dev Initiates an unshield of confidential tokens from `from` and creates a pending
     * unshield request for `to`. The caller must be `from` or an operator for `from`.
     *
     * Returns the encrypted amount that was burned.
     */
    function unshield(address from, address to, uint64 amount) external returns (sharedEuint64);

    /**
     * @dev Initiates an unshield of an encrypted `amount` from `from`, creating a pending
     * unshield request for `to`. The caller shares the handle with {FHE-shareEuint64} naming this
     * wrapper, and must be `from` or an operator for `from`.
     *
     * Returns the encrypted amount that was burned.
     */
    function unshield(address from, address to, sharedEuint64 sharedAmount) external returns (sharedEuint64);

    /**
     * @dev Claims a pending unshield request by verifying the decryption proof and transferring
     * `unshieldAmountCleartext * rate()` native tokens to the requester.
     */
    function claimUnshielded(
        bytes32 unshieldRequestId,
        uint64 unshieldAmountCleartext,
        bytes calldata decryptionProof
    ) external;

    /**
     * @dev Settles a pending unshield request in WETH rather than native value: deposits
     * `unshieldAmountCleartext * rate()` into the wrapper's WETH contract and transfers it to the
     * recipient recorded on the claim.
     *
     * Unlike {claimUnshielded} this is NOT permissionless — only the claim's recipient, or an
     * operator acting for them, may take this route. The recipient is the one who chose to unwind
     * into native value, so nobody else gets to hand them WETH instead.
     *
     * This is the escape hatch for a recipient that cannot accept native value (a contract with no
     * payable fallback), whose claim would otherwise be unsettleable forever.
     */
    function claimUnshieldedAsWETH(
        bytes32 unshieldRequestId,
        uint64 unshieldAmountCleartext,
        bytes calldata decryptionProof
    ) external;

    /// @dev Returns the conversion rate between the native token denomination and confidential precision.
    function rate() external view returns (uint256);

    /// @dev Returns the address of the WETH contract used for wrapped-native shielding.
    function weth() external view returns (address);
}
