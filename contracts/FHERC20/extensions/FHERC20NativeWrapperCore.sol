// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, sharedEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IFHERC20NativeWrapper } from "../../interfaces/IFHERC20NativeWrapper.sol";
import { IWETH } from "../../interfaces/IWETH.sol";
import { ERC20ConfidentialLib } from "../../ERC20Confidential/ERC20ConfidentialLib.sol";
import { FHERC20Core } from "../FHERC20Core.sol";
import { FHERC20WrapperClaims } from "../utils/FHERC20WrapperClaims.sol";
import { FHERC20InvalidReceiver, FHERC20UnauthorizedSpender, FHERC20UnauthorizedUseOfEncryptedAmount } from "../utils/FHERC20Errors.sol";

/**
 * @dev Shared core of the native wrapper — the single home of the shield/unshield/claim logic,
 * hosted by both the constructor-based {FHERC20NativeWrapper} and the proxy-friendly
 * {FHERC20NativeWrapperUpgradeable} (which previously each carried a full copy of this code).
 *
 * Shields a chain's native token (e.g. ETH) into a confidential {FHERC20} token.
 *
 * Two shield entry-points are provided:
 *  - {shieldWrappedNative}: pulls WETH from the caller, unwraps it to native, and mints
 *    confidential tokens.
 *  - {shieldNative}: accepts native value directly and mints confidential tokens.
 *    Any dust below the conversion rate is refunded to the caller.
 *
 * Confidential precision is capped at {_maxDecimals} (default 6). For 18-decimal native
 * tokens the conversion rate is 1e12, so 1 native unit = 1e-6 confidential units.
 *
 * Unshield claims are keyed by a unique per-claimant id (see {FHERC20WrapperClaims}) and their
 * bookkeeping lives in the linked {ERC20ConfidentialLib} — hosts must link the library.
 *
 * Wrapper config lives in the SAME ERC-7201 slot (`fherc20.storage.FHERC20NativeWrapper`) the
 * upgradeable variant always used, so existing proxies keep it across an upgrade.
 */
abstract contract FHERC20NativeWrapperCore is FHERC20Core, IFHERC20NativeWrapper, FHERC20WrapperClaims {
    using SafeERC20 for IWETH;

    /// @custom:storage-location erc7201:fherc20.storage.FHERC20NativeWrapper
    struct FHERC20NativeWrapperStorage {
        IWETH _weth;
        uint8 _wrappedDecimals;
        uint256 _rate;
    }

    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.FHERC20NativeWrapper")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FHERC20NativeWrapperStorageLocation =
        0x0214a37a5b14e296a5efb5a764e800995b21f3ab007895ee5e9a08ee59986900;

    function _getFHERC20NativeWrapperStorage() private pure returns (FHERC20NativeWrapperStorage storage $) {
        assembly {
            $.slot := FHERC20NativeWrapperStorageLocation
        }
    }

    error FHERC20TotalSupplyOverflow();
    error NativeTransferFailed();
    error AmountTooSmallForConfidentialPrecision();

    /// @dev Plain `internal` — the host guards one-time setup (constructor or OZ initializer).
    function __FHERC20NativeWrapperCore_init(IWETH weth_) internal {
        FHERC20NativeWrapperStorage storage $ = _getFHERC20NativeWrapperStorage();
        $._weth = weth_;

        uint8 tokenDecimals = IERC20Metadata(address(weth_)).decimals();
        uint8 maxDecimals = _maxDecimals();
        if (tokenDecimals > maxDecimals) {
            $._wrappedDecimals = maxDecimals;
            $._rate = 10 ** (tokenDecimals - maxDecimals);
        } else {
            $._wrappedDecimals = tokenDecimals;
            $._rate = 1;
        }
    }

    receive() external payable {}

    /// @inheritdoc IFHERC20NativeWrapper
    function shieldWrappedNative(address to, uint256 value) public virtual nonReentrant returns (sharedEuint64) {
        if (to == address(0)) to = msg.sender;

        uint256 alignedValue = value - (value % rate());
        if (alignedValue == 0) revert AmountTooSmallForConfidentialPrecision();

        uint64 confidentialAmount = SafeCast.toUint64(alignedValue / rate());

        _getFHERC20NativeWrapperStorage()._weth.safeTransferFrom(msg.sender, address(this), alignedValue);
        _getFHERC20NativeWrapperStorage()._weth.withdraw(alignedValue);

        euint64 shieldedAmountSent = _mint(to, FHE.asEuint64(confidentialAmount));

        emit ShieldedNative(msg.sender, to, alignedValue);
        return FHE.shareEuint64(shieldedAmountSent, msg.sender);
    }

    /// @inheritdoc IFHERC20NativeWrapper
    function shieldNative(address to) public payable virtual nonReentrant returns (sharedEuint64) {
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

        emit ShieldedNative(msg.sender, to, alignedValue);
        return FHE.shareEuint64(shieldedAmountSent, msg.sender);
    }

    /**
     * @dev Initiates an unshield of `amount` confidential tokens from `from`, creating a pending
     * claim for `to`. The caller must be `from` or an operator for `from`.
     *
     * Returns the encrypted amount that was burned. The claim is keyed by a unique id — read it
     * from {getClaim}/{getUserClaims}, NOT from the burned handle.
     */
    function unshield(address from, address to, uint64 amount) public virtual nonReentrant returns (sharedEuint64) {
        return FHE.shareEuint64(_unshield(from, to, FHE.asEuint64(amount)), msg.sender);
    }

    /**
     * @dev Initiates an unshield of an encrypted `amount` from `from`, creating a pending
     * unshield request for `to`. The caller must have ACL access to `amount` and must be
     * `from` or an operator for `from`.
     *
     * Returns the encrypted amount that was burned.
     */
    function unshield(
        address from,
        address to,
        sharedEuint64 sharedAmount
    ) public virtual nonReentrant returns (sharedEuint64) {
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        return FHE.shareEuint64(_unshield(from, to, amount), msg.sender);
    }

    /**
     * @dev Claims a pending unshield request by its unique claim id. Verifies the decryption
     * proof and transfers `decryptedAmount * rate()` native tokens to `claim.to`.
     */
    function claimUnshielded(
        bytes32 id,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) public virtual nonReentrant {
        ERC20ConfidentialLib.Claim memory claim = _handleClaim(id, decryptedAmount, decryptionProof);

        uint256 nativeAmount = uint256(claim.decryptedAmount) * rate();
        (bool sent, ) = claim.to.call{ value: nativeAmount }("");
        if (!sent) revert NativeTransferFailed();

        emit ClaimedUnshielded(claim.to, id, FHE.wrapEuint64(claim.ctHash), claim.decryptedAmount);
    }

    /// @inheritdoc IFHERC20NativeWrapper
    function claimUnshieldedAsWETH(
        bytes32 id,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) public virtual nonReentrant {
        // Read and authorize BEFORE settling: _handleClaim consumes the claim, and the gate is on
        // the recipient recorded at burn time.
        address to = getClaim(id).to;
        if (to == address(0)) revert ClaimNotFound();
        _checkClaimRecipient(to);

        ERC20ConfidentialLib.Claim memory claim = _handleClaim(id, decryptedAmount, decryptionProof);

        uint256 nativeAmount = uint256(claim.decryptedAmount) * rate();
        IWETH weth_ = _getFHERC20NativeWrapperStorage()._weth;
        weth_.deposit{ value: nativeAmount }();
        weth_.safeTransfer(claim.to, nativeAmount);

        emit ClaimedUnshielded(claim.to, id, FHE.wrapEuint64(claim.ctHash), claim.decryptedAmount);
        emit ClaimedUnshieldedAsWETH(claim.to, id, nativeAmount);
    }

    /**
     * @dev Claims multiple pending unshield requests (by unique claim ids) in a single transaction.
     */
    function claimUnshieldedBatch(
        bytes32[] memory ids,
        uint64[] memory decryptedAmounts,
        bytes[] memory decryptionProofs
    ) public virtual nonReentrant {
        ERC20ConfidentialLib.Claim[] memory claims = _handleClaimBatch(ids, decryptedAmounts, decryptionProofs);

        for (uint256 i = 0; i < claims.length; i++) {
            uint256 nativeAmount = uint256(claims[i].decryptedAmount) * rate();
            (bool sent, ) = claims[i].to.call{ value: nativeAmount }("");
            if (!sent) revert NativeTransferFailed();
            emit ClaimedUnshielded(claims[i].to, ids[i], FHE.wrapEuint64(claims[i].ctHash), claims[i].decryptedAmount);
        }
    }

    /// @inheritdoc FHERC20Core
    function decimals() public view virtual override returns (uint8) {
        return _getFHERC20NativeWrapperStorage()._wrappedDecimals;
    }

    /// @inheritdoc IFHERC20NativeWrapper
    function rate() public view virtual returns (uint256) {
        return _getFHERC20NativeWrapperStorage()._rate;
    }

    /// @inheritdoc IFHERC20NativeWrapper
    function weth() public view virtual returns (address) {
        return address(_getFHERC20NativeWrapperStorage()._weth);
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

    /// @inheritdoc FHERC20Core
    function _update(address from, address to, euint64 amount) internal virtual override returns (euint64) {
        if (from == address(0)) {
            _checkConfidentialTotalSupply();
        }
        return super._update(from, to, amount);
    }

    /// @inheritdoc FHERC20WrapperClaims
    function _isClaimOperator(address holder, address spender) internal view virtual override returns (bool) {
        return isOperator(holder, spender);
    }

    /// @dev Shared internal logic for both unshield overloads.
    function _unshield(address from, address to, euint64 amount) internal virtual returns (euint64) {
        if (to == address(0)) revert FHERC20InvalidReceiver(to);
        if (from != msg.sender && !isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);

        euint64 unshieldAmount_ = _burn(from, amount);
        FHE.allowPublic(unshieldAmount_);

        _createClaim(to, unshieldAmount_);

        emit Unshielded(to, unshieldAmount_);
        return unshieldAmount_;
    }

    /// @dev Returns the maximum number that will be used for {decimals} by the wrapper.
    function _maxDecimals() internal pure virtual returns (uint8) {
        return 6;
    }
}
