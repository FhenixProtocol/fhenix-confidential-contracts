// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IFHERC20NativeWrapper } from "../../interfaces/IFHERC20NativeWrapper.sol";
import { IWETH } from "../../interfaces/IWETH.sol";
import { FHERC20Upgradeable } from "../FHERC20Upgradeable.sol";
import { FHERC20WrapperClaimHelperUpgradeable } from "../utils/FHERC20WrapperClaimHelperUpgradeable.sol";
import { FHERC20InvalidReceiver, FHERC20UnauthorizedSpender } from "../utils/FHERC20Errors.sol";

/**
 * @dev Upgradeable wrapper that shields a chain's native token (e.g. ETH) into a confidential {FHERC20} token.
 *
 * This variant is designed to be used behind a UUPS proxy and follows the OpenZeppelin Initializable pattern.
 * Wrapper-specific state (`_weth`, `_wrappedDecimals`, `_rate`) is stored in ERC-7201 namespaced storage.
 */
abstract contract FHERC20NativeWrapperUpgradeable is
    FHERC20Upgradeable,
    IFHERC20NativeWrapper,
    FHERC20WrapperClaimHelperUpgradeable
{
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

    function __FHERC20NativeWrapper_init(IWETH weth_) internal onlyInitializing {
        __FHERC20WrapperClaimHelper_init();
        __FHERC20NativeWrapper_init_unchained(weth_);
    }

    function __FHERC20NativeWrapper_init_unchained(IWETH weth_) internal onlyInitializing {
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
    function shieldWrappedNative(address to, uint256 value) public virtual returns (euint64) {
        FHERC20NativeWrapperStorage storage $ = _getFHERC20NativeWrapperStorage();
        if (to == address(0)) to = msg.sender;

        uint256 alignedValue = value - (value % rate());
        if (alignedValue == 0) revert AmountTooSmallForConfidentialPrecision();

        uint64 confidentialAmount = SafeCast.toUint64(alignedValue / rate());

        $._weth.safeTransferFrom(msg.sender, address(this), alignedValue);
        $._weth.withdraw(alignedValue);

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

        uint256 nativeAmount = uint256(claim.decryptedAmount) * rate();
        (bool sent, ) = claim.to.call{ value: nativeAmount }("");
        if (!sent) revert NativeTransferFailed();

        emit ClaimedUnshielded(claim.to, ctHash, FHE.wrapEuint64(ctHash), claim.decryptedAmount);
    }

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

    /// @inheritdoc FHERC20Upgradeable
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

    /// @inheritdoc FHERC20Upgradeable
    function supportsInterface(bytes4 interfaceId) public view virtual override(FHERC20Upgradeable) returns (bool) {
        return interfaceId == type(IFHERC20NativeWrapper).interfaceId || super.supportsInterface(interfaceId);
    }

    function inferredTotalSupply() public view virtual returns (uint256) {
        return address(this).balance / rate();
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

    function _maxDecimals() internal pure virtual returns (uint8) {
        return 6;
    }
}
