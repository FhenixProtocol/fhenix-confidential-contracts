// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { FHE, euint64, InEuint64, ebool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20Confidential } from "../interfaces/IERC20Confidential.sol";
import { ERC20ConfidentialIndicator } from "./ERC20ConfidentialIndicator.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";
import { FHERC20WrapperClaimHelper } from "../FHERC20/utils/FHERC20WrapperClaimHelper.sol";

/**
 * @title ERC20Confidential
 * @dev Extension of ERC-20 to support a second, confidential (FHE-encrypted) balance layer.
 *
 * This contract provides dual-balance functionality:
 * - Standard ERC-20 balances and transfers (public)
 * - Confidential balances and transfers (encrypted via `euint64`)
 * - Shield/unshield to convert between public and confidential
 *
 * The confidential pool is represented by a fixed address where shielded tokens are stored.
 * The unshield flow is asynchronous: {unshield} burns confidential tokens and makes the
 * encrypted amount publicly decryptable, then {claimUnshielded} verifies the decryption
 * proof and transfers public tokens from the pool.
 */
abstract contract ERC20Confidential is ERC20, IERC20Confidential, FHERC20WrapperClaimHelper {
    address public constant CONFIDENTIAL_POOL = address(0x1011000000000000000000000000000000000000);

    mapping(address => euint64) private _confidentialBalances;
    mapping(address => mapping(address => uint48)) private _operators;

    ERC20ConfidentialIndicator public immutable indicatorToken;

    uint8 private immutable _decimals;
    uint8 private immutable _confidentialDecimals;
    uint256 private immutable _conversionRate;

    error ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(euint64 value, address user);
    error ERC20ConfidentialUnauthorizedSpender(address holder, address spender);
    error AmountTooSmallForConfidentialPrecision();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        indicatorToken = new ERC20ConfidentialIndicator(address(this), name_, symbol_);
        _decimals = decimals_;
        _confidentialDecimals = decimals_ <= 6 ? decimals_ : 6;
        _conversionRate = decimals_ > 6 ? 10 ** (decimals_ - 6) : 1;
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    function confidentialDecimals() public view virtual returns (uint8) {
        return _confidentialDecimals;
    }

    function confidentialBalanceOf(address account) public view virtual returns (euint64) {
        return _confidentialBalances[account];
    }

    function isOperator(address holder, address spender) public view virtual returns (bool) {
        return holder == spender || block.timestamp <= _operators[holder][spender];
    }

    // =========================================================================
    //  Shield / Unshield
    // =========================================================================

    function shield(uint256 amount) public virtual {
        uint256 rate = _rate();
        uint256 amountToShield = amount - (amount % rate);
        if (amountToShield == 0) {
            revert AmountTooSmallForConfidentialPrecision();
        }

        uint64 amountConfidential = SafeCast.toUint64(amountToShield / rate);

        _transfer(msg.sender, CONFIDENTIAL_POOL, amountToShield);
        _confidentialUpdate(address(0), msg.sender, FHE.asEuint64(amountConfidential));

        emit TokensShielded(msg.sender, amountToShield);
    }

    function unshield(uint64 amount) public virtual returns (euint64) {
        euint64 burned = _confidentialUpdate(msg.sender, address(0), FHE.asEuint64(amount));

        FHE.allowPublic(burned);
        _createClaim(msg.sender, amount, burned);

        emit TokensUnshielded(msg.sender, burned);
        return burned;
    }

    function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes calldata decryptionProof) public virtual {
        Claim memory claim = _handleClaim(ctHash, decryptedAmount, decryptionProof);

        uint256 amountPublic = uint256(claim.decryptedAmount) * _rate();
        _transfer(CONFIDENTIAL_POOL, claim.to, amountPublic);

        emit UnshieldedTokensClaimed(claim.to, ctHash, FHE.wrapEuint64(ctHash), claim.decryptedAmount);
    }

    // =========================================================================
    //  Confidential Transfers
    // =========================================================================

    function confidentialTransfer(address to, euint64 value) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        transferred = _confidentialTransfer(msg.sender, to, value);
        FHE.allowTransient(transferred, msg.sender);
    }

    function confidentialTransfer(
        address to,
        InEuint64 memory inValue
    ) public virtual returns (euint64 transferred) {
        transferred = _confidentialTransfer(msg.sender, to, FHE.asEuint64(inValue));
        FHE.allowTransient(transferred, msg.sender);
    }

    function confidentialTransferFrom(
        address from,
        address to,
        euint64 value
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        if (!isOperator(from, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        }
        transferred = _confidentialTransfer(from, to, value);
        FHE.allowTransient(transferred, msg.sender);
    }

    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory inValue
    ) public virtual returns (euint64 transferred) {
        if (!isOperator(from, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        }
        transferred = _confidentialTransfer(from, to, FHE.asEuint64(inValue));
        FHE.allowTransient(transferred, msg.sender);
    }

    // =========================================================================
    //  Operators
    // =========================================================================

    function setOperator(address operator, uint48 until) public virtual {
        _setOperator(msg.sender, operator, until);
    }

    // =========================================================================
    //  Confidential Mint (for inheriting contracts)
    // =========================================================================

    function _confidentialMint(address to, uint64 amount) internal virtual {
        _mint(CONFIDENTIAL_POOL, uint256(amount) * _rate());
        _confidentialUpdate(address(0), to, FHE.asEuint64(amount));
    }

    // =========================================================================
    //  Internal helpers
    // =========================================================================

    function _confidentialTransfer(
        address from,
        address to,
        euint64 value
    ) internal virtual returns (euint64 transferred) {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        transferred = _confidentialUpdate(from, to, value);
    }

    function _confidentialUpdate(
        address from,
        address to,
        euint64 amount
    ) internal virtual returns (euint64 transferred) {
        ebool success;
        euint64 ptr;

        if (from != address(0)) {
            euint64 fromBalance = _confidentialBalances[from];
            (success, ptr) = FHESafeMath.tryDecrease(fromBalance, amount);
            FHE.allowThis(ptr);
            FHE.allow(ptr, from);
            _confidentialBalances[from] = ptr;
        }

        transferred = from != address(0)
            ? FHE.select(success, amount, FHE.asEuint64(0))
            : amount;

        if (to != address(0)) {
            ptr = FHE.add(_confidentialBalances[to], transferred);
            FHE.allowThis(ptr);
            FHE.allow(ptr, to);
            _confidentialBalances[to] = ptr;
        }

        if (from != address(0)) FHE.allow(transferred, from);
        if (to != address(0)) FHE.allow(transferred, to);
        FHE.allowThis(transferred);

        indicatorToken.emitConfidentialTransfer(from, to);

        emit ConfidentialTransfer(from, to, transferred);
    }

    function _setOperator(address holder, address operator, uint48 until) internal virtual {
        _operators[holder][operator] = until;
        emit OperatorSet(holder, operator, until);
    }

    function _rate() internal view virtual returns (uint256) {
        return _conversionRate;
    }
}
