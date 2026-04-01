// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import { IERC1363Receiver } from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IFHERC20ERC20Wrapper } from "../../interfaces/IFHERC20ERC20Wrapper.sol";
import { FHERC20Upgradeable } from "../FHERC20Upgradeable.sol";
import { FHERC20WrapperClaimHelperUpgradeable } from "../utils/FHERC20WrapperClaimHelperUpgradeable.sol";

/**
 * @dev Upgradeable wrapper that shields a standard ERC-20 token into a confidential {FHERC20} token.
 *
 * This variant is designed to be used behind a UUPS proxy and follows the OpenZeppelin Initializable pattern.
 * Wrapper-specific state (`_underlying`, `_wrappedDecimals`, `_rate`) is stored in ERC-7201 namespaced storage.
 */
abstract contract FHERC20ERC20WrapperUpgradeable is
    FHERC20Upgradeable,
    IFHERC20ERC20Wrapper,
    IERC1363Receiver,
    FHERC20WrapperClaimHelperUpgradeable
{
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

    function __FHERC20ERC20Wrapper_init(IERC20 underlying_) internal onlyInitializing {
        __FHERC20WrapperClaimHelper_init();
        __FHERC20ERC20Wrapper_init_unchained(underlying_);
    }

    function __FHERC20ERC20Wrapper_init_unchained(IERC20 underlying_) internal onlyInitializing {
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

    function onTransferReceived(
        address,
        address from,
        uint256 amount,
        bytes calldata data
    ) public virtual returns (bytes4) {
        if (underlying() != msg.sender) revert FHERC20UnauthorizedCaller(msg.sender);

        address to = data.length < 20 ? from : address(bytes20(data));
        _mint(to, FHE.asEuint64(SafeCast.toUint64(amount / rate())));

        uint256 excess = amount % rate();
        if (excess > 0) SafeERC20.safeTransfer(IERC20(underlying()), from, excess);

        return IERC1363Receiver.onTransferReceived.selector;
    }

    function shield(address to, uint256 amount) public virtual override returns (euint64) {
        SafeERC20.safeTransferFrom(IERC20(underlying()), msg.sender, address(this), amount - (amount % rate()));

        euint64 shieldedAmountSent = _mint(to, FHE.asEuint64(SafeCast.toUint64(amount / rate())));
        FHE.allowTransient(shieldedAmountSent, msg.sender);

        return shieldedAmountSent;
    }

    function unshield(address from, address to, uint64 amount) public virtual returns (euint64) {
        if (to == address(0)) revert FHERC20InvalidReceiver(to);
        if (from != msg.sender && !isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);

        euint64 unshieldAmount_ = _burn(from, FHE.asEuint64(amount));
        FHE.allowPublic(unshieldAmount_);

        _createClaim(to, amount, unshieldAmount_);

        emit Unshielded(to, unshieldAmount_);
        return unshieldAmount_;
    }

    function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes memory decryptionProof) public virtual {
        Claim memory claim = _handleClaim(ctHash, decryptedAmount, decryptionProof);
        SafeERC20.safeTransfer(IERC20(underlying()), claim.to, uint256(claim.decryptedAmount) * rate());
        emit ClaimedUnshielded(claim.to, ctHash, FHE.wrapEuint64(ctHash), claim.decryptedAmount);
    }

    function claimUnshieldedBatch(
        bytes32[] memory ctHashes,
        uint64[] memory decryptedAmounts,
        bytes[] memory decryptionProofs
    ) public virtual {
        Claim[] memory claims = _handleClaimBatch(ctHashes, decryptedAmounts, decryptionProofs);

        for (uint256 i = 0; i < claims.length; i++) {
            SafeERC20.safeTransfer(IERC20(underlying()), claims[i].to, uint256(claims[i].decryptedAmount) * rate());
            emit ClaimedUnshielded(claims[i].to, ctHashes[i], FHE.wrapEuint64(ctHashes[i]), claims[i].decryptedAmount);
        }
    }

    /// @inheritdoc FHERC20Upgradeable
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

    /// @inheritdoc FHERC20Upgradeable
    function supportsInterface(bytes4 interfaceId) public view virtual override(FHERC20Upgradeable) returns (bool) {
        return
            interfaceId == type(IFHERC20ERC20Wrapper).interfaceId ||
            interfaceId == type(IERC1363Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function inferredTotalSupply() public view virtual returns (uint256) {
        return IERC20(underlying()).balanceOf(address(this)) / rate();
    }

    function maxTotalSupply() public view virtual returns (uint256) {
        return type(uint64).max;
    }

    function _checkConfidentialTotalSupply() internal virtual {
        if (inferredTotalSupply() > maxTotalSupply()) {
            revert FHERC20TotalSupplyOverflow();
        }
    }

    /// @inheritdoc FHERC20Upgradeable
    function _update(address from, address to, euint64 amount) internal virtual override returns (euint64) {
        if (from == address(0)) {
            _checkConfidentialTotalSupply();
        }
        return super._update(from, to, amount);
    }

    function _fallbackUnderlyingDecimals() internal pure virtual returns (uint8) {
        return 18;
    }

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
