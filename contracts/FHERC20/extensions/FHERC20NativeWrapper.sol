// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IFHERC20NativeWrapper } from "../../interfaces/IFHERC20NativeWrapper.sol";
import { IWETH } from "../../interfaces/IWETH.sol";
import { FHERC20 } from "../FHERC20.sol";
import { FHERC20WrapperClaimHelper } from "../utils/FHERC20WrapperClaimHelper.sol";

/**
 * @dev A wrapper contract built on top of {FHERC20} that shields a chain's native token
 * (e.g. ETH) into a confidential {FHERC20} token.
 *
 * Two shield entry-points are provided:
 *  - {shieldWrappedNative}: pulls WETH from the caller, unwraps it to native, and mints
 *    confidential tokens.
 *  - {shieldNative}: accepts native value directly and mints confidential tokens.
 *    Any dust below the conversion rate is refunded to the caller.
 *
 * Confidential precision is capped at {_maxDecimals} (default 6). For 18-decimal native
 * tokens the conversion rate is 1e12, so 1 native unit = 1e-6 confidential units.
 */
abstract contract FHERC20NativeWrapper is FHERC20, IFHERC20NativeWrapper, FHERC20WrapperClaimHelper {
    using SafeERC20 for IWETH;

    IWETH private immutable _weth;
    uint8 private immutable _wrappedDecimals;
    uint256 private immutable _rate;

    error FHERC20TotalSupplyOverflow();
    error NativeTransferFailed();
    error AmountTooSmallForConfidentialPrecision();

    constructor(IWETH weth_) {
        _weth = weth_;

        uint8 tokenDecimals = IERC20Metadata(address(weth_)).decimals();
        uint8 maxDecimals = _maxDecimals();
        if (tokenDecimals > maxDecimals) {
            _wrappedDecimals = maxDecimals;
            _rate = 10 ** (tokenDecimals - maxDecimals);
        } else {
            _wrappedDecimals = tokenDecimals;
            _rate = 1;
        }
    }

    receive() external payable {}

    /// @inheritdoc IFHERC20NativeWrapper
    function shieldWrappedNative(address to, uint256 value) public virtual returns (euint64) {
        if (to == address(0)) to = msg.sender;

        uint256 alignedValue = value - (value % rate());
        if (alignedValue == 0) revert AmountTooSmallForConfidentialPrecision();

        uint64 confidentialAmount = SafeCast.toUint64(alignedValue / rate());

        _weth.safeTransferFrom(msg.sender, address(this), alignedValue);
        _weth.withdraw(alignedValue);

        euint64 shieldedAmountSent = _mint(to, FHE.asEuint64(confidentialAmount));
        FHE.allowTransient(shieldedAmountSent, msg.sender);

        emit ShieldedNative(msg.sender, to, alignedValue);
        return shieldedAmountSent;
    }

    /// @inheritdoc IFHERC20NativeWrapper
    function shieldNative(address to) public payable virtual returns (euint64) {
        if (to == address(0)) to = msg.sender;

        uint256 alignedValue = msg.value - (msg.value % rate());
        if (alignedValue == 0) revert AmountTooSmallForConfidentialPrecision();

        uint256 dust = msg.value - alignedValue;
        if (dust > 0) {
            (bool refunded, ) = msg.sender.call{ value: dust }("");
            if (!refunded) revert NativeTransferFailed();
        }

        uint64 confidentialAmount = SafeCast.toUint64(alignedValue / rate());

        euint64 shieldedAmountSent = _mint(to, FHE.asEuint64(confidentialAmount));
        FHE.allowTransient(shieldedAmountSent, msg.sender);

        emit ShieldedNative(msg.sender, to, alignedValue);
        return shieldedAmountSent;
    }

    /**
     * @dev Initiates an unshield of `amount` confidential tokens from `from`, creating a pending
     * claim for `to`. The caller must be `from` or an operator for `from`.
     *
     * Returns the encrypted amount that was burned (used as the claim's cipher-text handle).
     */
    function unshield(address from, address to, uint64 amount) public virtual returns (euint64) {
        if (to == address(0)) revert FHERC20InvalidReceiver(to);
        if (from != msg.sender && !isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);

        euint64 unshieldAmount_ = _burn(from, FHE.asEuint64(amount));
        FHE.allowPublic(unshieldAmount_);

        _createClaim(to, amount, unshieldAmount_);

        emit Unshielded(to, unshieldAmount_);
        return unshieldAmount_;
    }

    /**
     * @dev Claims a pending unshield request. Verifies the decryption proof and transfers
     * `decryptedAmount * rate()` native tokens to the requester.
     */
    function claimUnshielded(
        bytes32 ctHash,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) public virtual {
        Claim memory claim = _handleClaim(ctHash, decryptedAmount, decryptionProof);

        uint256 nativeAmount = uint256(claim.decryptedAmount) * rate();
        (bool sent, ) = claim.to.call{ value: nativeAmount }("");
        if (!sent) revert NativeTransferFailed();

        emit ClaimedUnshielded(claim.to, ctHash, FHE.wrapEuint64(ctHash), claim.decryptedAmount);
    }

    /**
     * @dev Claims multiple pending unshield requests in a single transaction.
     */
    function claimUnshieldedBatch(
        bytes32[] memory ctHashes,
        uint64[] memory decryptedAmounts,
        bytes[] memory decryptionProofs
    ) public virtual {
        Claim[] memory claims = _handleClaimBatch(ctHashes, decryptedAmounts, decryptionProofs);

        for (uint256 i = 0; i < claims.length; i++) {
            uint256 nativeAmount = uint256(claims[i].decryptedAmount) * rate();
            (bool sent, ) = claims[i].to.call{ value: nativeAmount }("");
            if (!sent) revert NativeTransferFailed();
            emit ClaimedUnshielded(claims[i].to, ctHashes[i], FHE.wrapEuint64(ctHashes[i]), claims[i].decryptedAmount);
        }
    }

    /// @inheritdoc FHERC20
    function decimals() public view virtual override returns (uint8) {
        return _wrappedDecimals;
    }

    /// @inheritdoc IFHERC20NativeWrapper
    function rate() public view virtual returns (uint256) {
        return _rate;
    }

    /// @inheritdoc IFHERC20NativeWrapper
    function weth() public view virtual returns (address) {
        return address(_weth);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IFHERC20NativeWrapper).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /**
     * @dev Returns the native balance held by this contract divided by the {rate},
     * a value greater or equal to the actual {confidentialTotalSupply}.
     *
     * NOTE: The return value can be inflated by directly sending native tokens to the contract.
     * Reductions will lag compared to {confidentialTotalSupply} since it is updated on {unshield}
     * while this function updates on {claimUnshielded}.
     */
    function inferredTotalSupply() public view virtual returns (uint256) {
        return address(this).balance / rate();
    }

    /// @dev Returns the maximum total supply of shielded tokens supported by the encrypted datatype.
    function maxTotalSupply() public view virtual returns (uint256) {
        return type(uint64).max;
    }

    /**
     * @dev This function must revert if the new {confidentialTotalSupply} is invalid (overflow occurred).
     *
     * NOTE: Overflow can be detected here since the native balance is non-confidential.
     * This function may revert even if the {confidentialTotalSupply} did not overflow.
     */
    function _checkConfidentialTotalSupply() internal virtual {
        if (inferredTotalSupply() > maxTotalSupply()) {
            revert FHERC20TotalSupplyOverflow();
        }
    }

    /// @inheritdoc FHERC20
    function _update(address from, address to, euint64 amount) internal virtual override returns (euint64) {
        if (from == address(0)) {
            _checkConfidentialTotalSupply();
        }
        return super._update(from, to, amount);
    }

    /// @dev Returns the maximum number that will be used for {decimals} by the wrapper.
    function _maxDecimals() internal pure virtual returns (uint8) {
        return 6;
    }
}
