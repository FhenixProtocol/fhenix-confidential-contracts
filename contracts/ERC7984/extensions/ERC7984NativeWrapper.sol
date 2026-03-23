// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IERC7984NativeWrapper } from "../../interfaces/IERC7984NativeWrapper.sol";
import { IWETH } from "../../interfaces/IWETH.sol";
import { ERC7984 } from "../ERC7984.sol";

/**
 * @dev A wrapper contract built on top of {ERC7984} that shields a chain's native token
 * (e.g. ETH) into a confidential {ERC7984} token.
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
abstract contract ERC7984NativeWrapper is ERC7984, IERC7984NativeWrapper {
    using SafeERC20 for IWETH;

    IWETH private immutable _weth;
    uint8 private immutable _wrappedDecimals;
    uint256 private immutable _rate;

    string private _wrappedName;
    string private _wrappedSymbol;

    mapping(bytes32 unshieldRequestId => address recipient) private _unshieldRequests;

    error InvalidUnshieldRequest(bytes32 unshieldRequestId);
    error ERC7984TotalSupplyOverflow();
    error NativeTransferFailed();
    error AmountTooSmallForConfidentialPrecision();

    event SymbolUpdated(string symbol);

    constructor(IWETH weth_, string memory name_, string memory symbol_) {
        _weth = weth_;

        _wrappedName = name_;
        _wrappedSymbol = symbol_;

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

    /// @dev Returns the name for this wrapped native token.
    function name() public view virtual override returns (string memory) {
        return _wrappedName;
    }

    /// @dev Returns the symbol for this wrapped native token.
    function symbol() public view virtual override returns (string memory) {
        return _wrappedSymbol;
    }

    /**
     * @dev Updates the symbol of this wrapped token.
     *
     * NOTE: Access control should be implemented by the inheriting contract.
     */
    function _updateSymbol(string memory updatedSymbol) internal virtual {
        _wrappedSymbol = updatedSymbol;
        emit SymbolUpdated(updatedSymbol);
    }

    /// @inheritdoc IERC7984NativeWrapper
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

    /// @inheritdoc IERC7984NativeWrapper
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

    /// @dev Unshield without passing an input proof. See {unshield-address-address-InEuint64} for more details.
    function unshield(address from, address to, euint64 amount) public virtual returns (bytes32) {
        if (!FHE.isAllowed(amount, msg.sender)) revert ERC7984UnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        return _unshield(from, to, amount);
    }

    /**
     * @dev See {IERC7984NativeWrapper-unshield}. `amount * rate()` native tokens will be sent to `to`
     * once the unshield request is claimed via {claimUnshielded}.
     *
     * NOTE: The unshield request created by this function must be finalized by calling {claimUnshielded}.
     */
    function unshield(address from, address to, InEuint64 memory encryptedAmount) public virtual returns (bytes32) {
        return _unshield(from, to, FHE.asEuint64(encryptedAmount));
    }

    /// @inheritdoc IERC7984NativeWrapper
    function claimUnshielded(
        bytes32 unshieldRequestId,
        uint64 unshieldAmountCleartext,
        bytes calldata decryptionProof
    ) public virtual {
        address to = unshieldRequester(unshieldRequestId);
        if (to == address(0)) revert InvalidUnshieldRequest(unshieldRequestId);

        euint64 unshieldAmount_ = unshieldAmount(unshieldRequestId);
        delete _unshieldRequests[unshieldRequestId];

        FHE.verifyDecryptResult(unshieldAmount_, unshieldAmountCleartext, decryptionProof);

        uint256 nativeAmount = uint256(unshieldAmountCleartext) * rate();
        (bool sent, ) = to.call{ value: nativeAmount }("");
        if (!sent) revert NativeTransferFailed();

        emit ClaimedUnshielded(to, unshieldRequestId, unshieldAmount_, unshieldAmountCleartext);
    }

    /// @inheritdoc ERC7984
    function decimals() public view virtual override returns (uint8) {
        return _wrappedDecimals;
    }

    /// @inheritdoc IERC7984NativeWrapper
    function rate() public view virtual returns (uint256) {
        return _rate;
    }

    /// @inheritdoc IERC7984NativeWrapper
    function weth() public view virtual returns (address) {
        return address(_weth);
    }

    /// @inheritdoc IERC7984NativeWrapper
    function unshieldAmount(bytes32 unshieldRequestId) public view virtual returns (euint64) {
        return euint64.wrap(unshieldRequestId);
    }

    /// @inheritdoc IERC165
    function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
        return
            interfaceId == type(IERC7984NativeWrapper).interfaceId ||
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
     * @dev Get the address that has a pending unshield request for the given `unshieldRequestId`.
     * Returns `address(0)` if no pending unshield request exists.
     */
    function unshieldRequester(bytes32 unshieldRequestId) public view virtual returns (address) {
        return _unshieldRequests[unshieldRequestId];
    }

    /**
     * @dev This function must revert if the new {confidentialTotalSupply} is invalid (overflow occurred).
     *
     * NOTE: Overflow can be detected here since the native balance is non-confidential.
     * This function may revert even if the {confidentialTotalSupply} did not overflow.
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

    /// @dev Internal logic for handling the creation of unshield requests. Returns the unshield request id.
    function _unshield(address from, address to, euint64 amount) internal virtual returns (bytes32) {
        if (to == address(0)) revert ERC7984InvalidReceiver(to);
        if (from != msg.sender && !isOperator(from, msg.sender)) revert ERC7984UnauthorizedSpender(from, msg.sender);

        euint64 unshieldAmount_ = _burn(from, amount);
        FHE.allowPublic(unshieldAmount_);

        assert(unshieldRequester(euint64.unwrap(unshieldAmount_)) == address(0));

        bytes32 unshieldRequestId = euint64.unwrap(unshieldAmount_);
        _unshieldRequests[unshieldRequestId] = to;

        emit Unshielded(to, unshieldRequestId, unshieldAmount_);
        return unshieldRequestId;
    }

    /// @dev Returns the maximum number that will be used for {decimals} by the wrapper.
    function _maxDecimals() internal pure virtual returns (uint8) {
        return 6;
    }
}
