// SPDX-License-Identifier: MIT

pragma solidity ^0.8.25;

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { euint64, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20 } from "./FHERC20.sol";
import { FHERC20UnshieldClaim } from "./FHERC20UnshieldClaim.sol";
import { IWETH } from "./interfaces/IWETH.sol";

/**
 * @title FHERC20WrappedNative
 * @notice Confidential wrapper for a chain's native token (e.g. ETH).
 *
 * Accepts value via two entry-points:
 *  - `shieldWrappedNative(address to, uint256 value)` — pulls WETH from the caller, unwraps it to
 *    native, and mints confidential tokens.
 *  - `shieldNative(address to)` payable — accepts native directly and mints confidential
 *    tokens. Any dust below the conversion rate is refunded to the caller.
 *
 * Confidential precision is capped at 6 decimals (euint64 limit). For 18-decimal native
 * tokens the conversion rate is 1e12, so 1 native unit = 1e-6 confidential units.
 * The wrapper's `decimals()` reports this confidential precision, not the underlying's.
 */
contract FHERC20WrappedNative is FHERC20, Ownable, FHERC20UnshieldClaim {
    using SafeERC20 for IWETH;

    IWETH public immutable weth;
    uint256 public immutable conversionRate;

    event ShieldedNative(address indexed from, address indexed to, uint256 value);
    event UnshieldedNative(address indexed from, address indexed to, uint64 value);
    event ClaimedUnshieldedNative(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Native token transfer failed during claim.
     */
    error NativeTransferFailed();

    /**
     * @dev The shielded amount is too small to represent at confidential precision.
     */
    error AmountTooSmallForConfidentialPrecision();

    constructor(
        IWETH weth_,
        string memory nameOverride_,
        string memory symbolOverride_
    )
        Ownable(msg.sender)
        FHERC20(
            bytes(nameOverride_).length == 0
                ? string.concat("FHERC20 Wrapped ", IERC20Metadata(address(weth_)).name())
                : nameOverride_,
            bytes(symbolOverride_).length == 0
                ? string.concat("e", IERC20Metadata(address(weth_)).symbol())
                : symbolOverride_,
            // Cap at 6 decimals so balances fit safely within euint64.
            IERC20Metadata(address(weth_)).decimals() <= 6 ? IERC20Metadata(address(weth_)).decimals() : 6
        )
    {
        weth = weth_;

        uint8 underlyingDecimals = IERC20Metadata(address(weth_)).decimals();
        conversionRate = underlyingDecimals > 6 ? 10 ** (underlyingDecimals - 6) : 1;
    }

    // Accept native ETH from WETH.withdraw() calls.
    receive() external payable {}

    /**
     * @notice Shield WETH into confidential tokens.
     * Pulls `value` WETH from the caller, unwraps it to native, and mints the
     * equivalent confidential amount. `value` is truncated to the nearest multiple
     * of `conversionRate`; the remainder is not transferred.
     */
    function shieldWrappedNative(address to, uint256 value) public {
        if (to == address(0)) to = msg.sender;

        uint256 alignedValue = value - (value % conversionRate);
        if (alignedValue == 0) revert AmountTooSmallForConfidentialPrecision();

        uint64 confidentialAmount = SafeCast.toUint64(alignedValue / conversionRate);

        weth.safeTransferFrom(msg.sender, address(this), alignedValue);
        weth.withdraw(alignedValue);

        _mint(to, confidentialAmount);
        emit ShieldedNative(msg.sender, to, alignedValue);
    }

    /**
     * @notice Shield native tokens into confidential tokens.
     * `msg.value` is truncated to the nearest multiple of `conversionRate`; any
     * dust below the threshold is refunded to the caller.
     */
    function shieldNative(address to) public payable {
        if (to == address(0)) to = msg.sender;

        uint256 alignedValue = msg.value - (msg.value % conversionRate);
        if (alignedValue == 0) revert AmountTooSmallForConfidentialPrecision();

        // Refund precision dust so the caller doesn't lose value.
        uint256 dust = msg.value - alignedValue;
        if (dust > 0) {
            (bool refunded, ) = msg.sender.call{ value: dust }("");
            if (!refunded) revert NativeTransferFailed();
        }

        uint64 confidentialAmount = SafeCast.toUint64(alignedValue / conversionRate);

        _mint(to, confidentialAmount);
        emit ShieldedNative(msg.sender, to, alignedValue);
    }

    /**
     * @notice Initiate an unshield. Burns confidential tokens and creates a pending
     * claim that can be finalised once the FHE decryption is available.
     */
    function unshield(address to, uint64 value) public {
        if (to == address(0)) to = msg.sender;
        euint64 burned = _burn(msg.sender, value);
        FHE.allowPublic(burned);
        _createClaim(to, value, burned);
        emit UnshieldedNative(msg.sender, to, value);
    }

    /**
     * @notice Claim a single decrypted unshield, sending native tokens to the recipient.
     * @param ctHash             The ctHash of the burned confidential amount.
     * @param decryptedAmount    The decrypted confidential amount.
     * @param decryptionSignature Signature from the FHE decryption service.
     */
    function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes memory decryptionSignature) public {
        Claim memory claim = _handleClaim(ctHash, decryptedAmount, decryptionSignature);

        uint256 nativeAmount = uint256(claim.decryptedAmount) * conversionRate;
        (bool sent, ) = claim.to.call{ value: nativeAmount }("");
        if (!sent) revert NativeTransferFailed();

        emit ClaimedUnshieldedNative(msg.sender, claim.to, nativeAmount);
    }

    /**
     * @notice Claim multiple decrypted unshields in a single transaction.
     * @param ctHashes            The ctHashes of the burned confidential amounts.
     * @param decryptedAmounts    The decrypted confidential amounts.
     * @param decryptionSignatures Signatures from the FHE decryption service.
     */
    function claimUnshieldedBatch(
        bytes32[] memory ctHashes,
        uint64[] memory decryptedAmounts,
        bytes[] memory decryptionSignatures
    ) public {
        if (ctHashes.length != decryptedAmounts.length || ctHashes.length != decryptionSignatures.length) {
            revert LengthMismatch();
        }

        Claim[] memory claims = _handleClaimBatch(ctHashes, decryptedAmounts, decryptionSignatures);

        for (uint256 i = 0; i < claims.length; i++) {
            uint256 nativeAmount = uint256(claims[i].decryptedAmount) * conversionRate;
            (bool sent, ) = claims[i].to.call{ value: nativeAmount }("");
            if (!sent) revert NativeTransferFailed();
            emit ClaimedUnshieldedNative(msg.sender, claims[i].to, nativeAmount);
        }
    }
}
