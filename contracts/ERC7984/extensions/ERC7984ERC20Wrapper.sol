// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import { IERC1363Receiver } from "@openzeppelin/contracts/interfaces/IERC1363Receiver.sol";
import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IERC7984ERC20Wrapper } from "../../interfaces/IERC7984ERC20Wrapper.sol";
import { ERC7984 } from "../ERC7984.sol";
import { ERC7984WrapperClaimHelper } from "../utils/ERC7984WrapperClaimHelper.sol";

/**
 * @dev A wrapper contract built on top of {ERC7984} that allows shielding an `ERC20` token
 * into an `ERC7984` token. The wrapper contract implements the `IERC1363Receiver` interface
 * which allows users to transfer `ERC1363` tokens directly to the wrapper with a callback to shield the tokens.
 *
 * WARNING: Minting assumes the full amount of the underlying token transfer has been received, hence some non-standard
 * tokens such as fee-on-transfer or other deflationary-type tokens are not supported by this wrapper.
 */
abstract contract ERC7984ERC20Wrapper is ERC7984, IERC7984ERC20Wrapper, IERC1363Receiver, ERC7984WrapperClaimHelper {
    IERC20 private immutable _underlying;
    uint8 private immutable _wrappedDecimals;
    uint256 private immutable _rate;

    error ERC7984TotalSupplyOverflow();

    constructor(IERC20 underlying_) {
        _underlying = underlying_;

        uint8 tokenDecimals = _tryGetAssetDecimals(underlying_);
        uint8 maxDecimals = _maxDecimals();
        if (tokenDecimals > maxDecimals) {
            _wrappedDecimals = maxDecimals;
            _rate = 10 ** (tokenDecimals - maxDecimals);
        } else {
            _wrappedDecimals = tokenDecimals;
            _rate = 1;
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
    ) public virtual returns (bytes4) {
        if (underlying() != msg.sender) revert ERC7984UnauthorizedCaller(msg.sender);

        address to = data.length < 20 ? from : address(bytes20(data));
        _mint(to, FHE.asEuint64(SafeCast.toUint64(amount / rate())));

        uint256 excess = amount % rate();
        if (excess > 0) SafeERC20.safeTransfer(IERC20(underlying()), from, excess);

        return IERC1363Receiver.onTransferReceived.selector;
    }

    /**
     * @dev See {IERC7984ERC20Wrapper-shield}. Tokens are exchanged at a fixed rate specified by {rate} such that
     * `amount / rate()` confidential tokens are sent. The amount transferred in is rounded down to the nearest
     * multiple of {rate}.
     *
     * Returns the amount of shielded token sent.
     */
    function shield(address to, uint256 amount) public virtual override returns (euint64) {
        SafeERC20.safeTransferFrom(IERC20(underlying()), msg.sender, address(this), amount - (amount % rate()));

        euint64 shieldedAmountSent = _mint(to, FHE.asEuint64(SafeCast.toUint64(amount / rate())));
        FHE.allowTransient(shieldedAmountSent, msg.sender);

        return shieldedAmountSent;
    }

    /**
     * @dev Initiates an unshield of `amount` confidential tokens from `from`, creating a pending
     * claim for `to`. The caller must be `from` or an operator for `from`.
     *
     * Returns the encrypted amount that was burned (used as the claim's cipher-text handle).
     */
    function unshield(address from, address to, uint64 amount) public virtual returns (euint64) {
        if (to == address(0)) revert ERC7984InvalidReceiver(to);
        if (from != msg.sender && !isOperator(from, msg.sender)) revert ERC7984UnauthorizedSpender(from, msg.sender);

        euint64 unshieldAmount_ = _burn(from, FHE.asEuint64(amount));
        FHE.allowPublic(unshieldAmount_);

        _createClaim(to, amount, unshieldAmount_);

        emit Unshielded(to, unshieldAmount_);
        return unshieldAmount_;
    }

    /**
     * @dev Claims a pending unshield request. Verifies the decryption proof and transfers
     * `decryptedAmount * rate()` underlying tokens to the requester.
     */
    function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes memory decryptionProof) public virtual {
        Claim memory claim = _handleClaim(ctHash, decryptedAmount, decryptionProof);
        SafeERC20.safeTransfer(IERC20(underlying()), claim.to, uint256(claim.decryptedAmount) * rate());
        emit ClaimedUnshielded(claim.to, ctHash, euint64.wrap(ctHash), claim.decryptedAmount);
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
            SafeERC20.safeTransfer(IERC20(underlying()), claims[i].to, uint256(claims[i].decryptedAmount) * rate());
            emit ClaimedUnshielded(claims[i].to, ctHashes[i], euint64.wrap(ctHashes[i]), claims[i].decryptedAmount);
        }
    }

    /// @inheritdoc ERC7984
    function decimals() public view virtual override returns (uint8) {
        return _wrappedDecimals;
    }

    /// @inheritdoc IERC7984ERC20Wrapper
    function rate() public view virtual returns (uint256) {
        return _rate;
    }

    /// @inheritdoc IERC7984ERC20Wrapper
    function underlying() public view virtual override returns (address) {
        return address(_underlying);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IERC7984ERC20Wrapper).interfaceId ||
            interfaceId == type(IERC1363Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
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
            revert ERC7984TotalSupplyOverflow();
        }
    }

    /// @inheritdoc ERC7984
    function _update(address from, address to, euint64 amount) internal virtual override returns (euint64) {
        if (from == address(0)) {
            _checkConfidentialTotalSupply();
        }
        return super._update(from, to, amount);
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
