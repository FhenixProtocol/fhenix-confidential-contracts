// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, sharedEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import { IERC1363Receiver } from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IFHERC20ERC20Wrapper } from "../../interfaces/IFHERC20ERC20Wrapper.sol";
import { ERC20ConfidentialLib } from "../../ERC20Confidential/ERC20ConfidentialLib.sol";
import { FHERC20Core } from "../FHERC20Core.sol";
import { FHERC20WrapperClaims } from "../utils/FHERC20WrapperClaims.sol";
import { FHERC20InvalidReceiver, FHERC20UnauthorizedSpender, FHERC20UnauthorizedCaller, FHERC20UnauthorizedUseOfEncryptedAmount } from "../utils/FHERC20Errors.sol";

/**
 * @dev Shared core of the ERC-20 wrapper — the single home of the wrap/shield/unshield/claim
 * logic, hosted by both the constructor-based {FHERC20ERC20Wrapper} and the proxy-friendly
 * {FHERC20ERC20WrapperUpgradeable} (which previously each carried a full copy of this code).
 *
 * Shields an `ERC20` token into an `FHERC20` token. Implements `IERC1363Receiver`, which allows
 * users to transfer `ERC1363` tokens directly to the wrapper with a callback to shield the tokens.
 *
 * Unshield claims are keyed by a unique per-claimant id (see {FHERC20WrapperClaims}) and their
 * bookkeeping lives in the linked {ERC20ConfidentialLib} — hosts must link the library.
 *
 * Wrapper config lives in the SAME ERC-7201 slot (`fherc20.storage.FHERC20ERC20Wrapper`) the
 * upgradeable variant always used, so existing proxies keep it across an upgrade.
 *
 * WARNING: Minting assumes the full amount of the underlying token transfer has been received, hence some non-standard
 * tokens such as fee-on-transfer or other deflationary-type tokens are not supported by this wrapper.
 */
abstract contract FHERC20ERC20WrapperCore is FHERC20Core, IFHERC20ERC20Wrapper, IERC1363Receiver, FHERC20WrapperClaims {
    /// @custom:storage-location erc7201:fherc20.storage.FHERC20ERC20Wrapper
    struct FHERC20ERC20WrapperStorage {
        IERC20 _underlying;
        uint8 _wrappedDecimals;
        uint256 _rate;
    }

    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.FHERC20ERC20Wrapper")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FHERC20ERC20WrapperStorageLocation =
        0x4e88f5b0860d1f98706c128e62bcc7e5dbeb109d021b0117348148502362e000;

    function _getFHERC20ERC20WrapperStorage() private pure returns (FHERC20ERC20WrapperStorage storage $) {
        assembly {
            $.slot := FHERC20ERC20WrapperStorageLocation
        }
    }

    error FHERC20TotalSupplyOverflow();
    error AmountTooSmallForConfidentialPrecision();

    /// @dev Plain `internal` — the host guards one-time setup (constructor or OZ initializer).
    function __FHERC20ERC20WrapperCore_init(IERC20 underlying_) internal {
        FHERC20ERC20WrapperStorage storage $ = _getFHERC20ERC20WrapperStorage();
        $._underlying = underlying_;

        uint8 tokenDecimals = _tryGetAssetDecimals(underlying_);
        uint8 maxDecimals = _maxDecimals();
        if (tokenDecimals > maxDecimals) {
            $._wrappedDecimals = maxDecimals;
            $._rate = 10 ** (tokenDecimals - maxDecimals);
        } else {
            $._wrappedDecimals = tokenDecimals;
            $._rate = 1;
        }
    }

    /**
     * @dev `ERC1363` callback function which shields tokens to the address specified in `data` or
     * the address `from` (if no address is specified in `data`). This function refunds any excess tokens
     * sent beyond the nearest multiple of {rate} to `from`. See {shield} for more details on shielding tokens.
     */
    function onTransferReceived(
        address,
        address from,
        uint256 amount,
        bytes calldata data
    ) public virtual nonReentrant returns (bytes4) {
        if (underlying() != msg.sender) revert FHERC20UnauthorizedCaller(msg.sender);

        address to = data.length < 20 ? from : address(bytes20(data));
        (uint256 alignedAmount, uint64 confidentialAmount) = _alignShieldAmount(amount);
        _mint(to, FHE.asEuint64(confidentialAmount));

        uint256 excess = amount - alignedAmount;
        if (excess > 0) SafeERC20.safeTransfer(IERC20(underlying()), from, excess);

        return IERC1363Receiver.onTransferReceived.selector;
    }

    /**
     * @dev See {IFHERC20ERC20Wrapper-shield}. Tokens are exchanged at a fixed rate specified by {rate} such that
     * `amount / rate()` confidential tokens are sent. The amount transferred in is rounded down to the nearest
     * multiple of {rate}.
     *
     * Returns the amount of shielded token sent.
     */
    function shield(address to, uint256 amount) public virtual override nonReentrant returns (sharedEuint64) {
        (uint256 alignedAmount, uint64 confidentialAmount) = _alignShieldAmount(amount);
        SafeERC20.safeTransferFrom(IERC20(underlying()), msg.sender, address(this), alignedAmount);

        euint64 shieldedAmountSent = _mint(to, FHE.asEuint64(confidentialAmount));

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
     * proof and transfers `decryptedAmount * rate()` underlying tokens to the requester.
     */
    function claimUnshielded(
        bytes32 id,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) public virtual nonReentrant {
        ERC20ConfidentialLib.Claim memory claim = _handleClaim(id, decryptedAmount, decryptionProof);
        SafeERC20.safeTransfer(IERC20(underlying()), claim.to, uint256(claim.decryptedAmount) * rate());
        emit ClaimedUnshielded(claim.to, id, FHE.wrapEuint64(claim.ctHash), claim.decryptedAmount);
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
            SafeERC20.safeTransfer(IERC20(underlying()), claims[i].to, uint256(claims[i].decryptedAmount) * rate());
            emit ClaimedUnshielded(claims[i].to, ids[i], FHE.wrapEuint64(claims[i].ctHash), claims[i].decryptedAmount);
        }
    }

    /// @inheritdoc FHERC20Core
    function decimals() public view virtual override returns (uint8) {
        return _getFHERC20ERC20WrapperStorage()._wrappedDecimals;
    }

    /// @inheritdoc IFHERC20ERC20Wrapper
    function rate() public view virtual returns (uint256) {
        return _getFHERC20ERC20WrapperStorage()._rate;
    }

    /// @inheritdoc IFHERC20ERC20Wrapper
    function underlying() public view virtual override returns (address) {
        return address(_getFHERC20ERC20WrapperStorage()._underlying);
    }

    /**
     * @dev Returns the underlying balance divided by the {rate}, a value greater or equal to the actual
     * {confidentialTotalSupply}.
     *
     * NOTE: The return value of this function can be inflated by directly sending underlying tokens to the wrapper contract.
     * Reductions will lag compared to {confidentialTotalSupply} since it is updated on {unshield} while this function updates
     * on {claimUnshielded}.
     */
    function inferredTotalSupply() public view virtual returns (uint256) {
        return IERC20(underlying()).balanceOf(address(this)) / rate();
    }

    /// @dev Returns the maximum total supply of shielded tokens supported by the encrypted datatype.
    function maxTotalSupply() public view virtual returns (uint256) {
        return type(uint64).max;
    }

    /**
     * @dev This function must revert if the new {confidentialTotalSupply} is invalid (overflow occurred).
     *
     * NOTE: Overflow can be detected here since the wrapper holdings are non-confidential. In other cases, it may be impossible
     * to infer total supply overflow synchronously. This function may revert even if the {confidentialTotalSupply} did
     * not overflow.
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

    /// @dev Aligns an underlying amount to the wrapper rate and rejects a zero confidential result.
    function _alignShieldAmount(
        uint256 amount
    ) private view returns (uint256 alignedAmount, uint64 confidentialAmount) {
        uint256 conversionRate = rate();
        alignedAmount = amount - (amount % conversionRate);
        if (alignedAmount == 0) revert AmountTooSmallForConfidentialPrecision();
        confidentialAmount = SafeCast.toUint64(alignedAmount / conversionRate);
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

    /**
     * @dev Returns the default number of decimals of the underlying ERC-20 token.
     * Used as a fallback when {_tryGetAssetDecimals} fails.
     */
    function _fallbackUnderlyingDecimals() internal pure virtual returns (uint8) {
        return 18;
    }

    /// @dev Returns the maximum number that will be used for {decimals} by the wrapper.
    function _maxDecimals() internal pure virtual returns (uint8) {
        return 6;
    }

    function _tryGetAssetDecimals(IERC20 asset_) private view returns (uint8 assetDecimals) {
        (bool success, bytes memory encodedDecimals) = address(asset_).staticcall(
            abi.encodeCall(IERC20Metadata.decimals, ())
        );
        if (success && encodedDecimals.length == 32) {
            return abi.decode(encodedDecimals, (uint8));
        }
        return _fallbackUnderlyingDecimals();
    }
}
