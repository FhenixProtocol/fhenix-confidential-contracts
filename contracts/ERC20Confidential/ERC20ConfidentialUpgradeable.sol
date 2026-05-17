// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/interfaces/IERC165.sol";
import { ERC165Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { FHE, euint64, InEuint64, ebool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IFHERC20, IERC7984 } from "../interfaces/IFHERC20.sol";
import { IERC20Confidential } from "../interfaces/IERC20Confidential.sol";
import { ERC20ConfidentialIndicator } from "./ERC20ConfidentialIndicator.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";
import { FHERC20Utils } from "../FHERC20/utils/FHERC20Utils.sol";
import { FHERC20WrapperClaimHelperUpgradeable } from "../FHERC20/utils/FHERC20WrapperClaimHelperUpgradeable.sol";

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
abstract contract ERC20ConfidentialUpgradeable is
    Initializable,
    ERC20Upgradeable,
    ERC165Upgradeable,
    IERC20Confidential,
    FHERC20WrapperClaimHelperUpgradeable
{
    address public constant CONFIDENTIAL_POOL = address(0x1011000000000000000000000000000000000000);

    /// @custom:storage-location erc7201:fherc20.storage.ERC20Confidential
    struct ERC20ConfidentialStorage {
        mapping(address => euint64) _confidentialBalances;
        mapping(address => mapping(address => uint48)) _operators;
        euint64 _confidentialTotalSupply;
        ERC20ConfidentialIndicator _indicatorToken;
        uint8 _decimals;
        uint8 _confidentialDecimals;
        uint256 _conversionRate;
    }

    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.ERC20Confidential")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC20ConfidentialStorageLocation =
        0xb440e9c559aceef9e2c75ec16e8d26ee97396e4a6978215085407b7ab0709e00;

    function _getERC20ConfidentialStorage() private pure returns (ERC20ConfidentialStorage storage $) {
        assembly {
            $.slot := ERC20ConfidentialStorageLocation
        }
    }

    error ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(euint64 value, address user);
    error ERC20ConfidentialUnauthorizedSpender(address holder, address spender);
    error AmountTooSmallForConfidentialPrecision();

    function __ERC20Confidential_init(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) internal onlyInitializing {
        __ERC20_init(name_, symbol_);
        __FHERC20WrapperClaimHelper_init();
        __ERC20Confidential_init_unchained(name_, symbol_, decimals_);
    }

    function __ERC20Confidential_init_unchained(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) internal onlyInitializing {
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        $._indicatorToken = new ERC20ConfidentialIndicator(address(this), name_, symbol_);
        $._decimals = decimals_;
        $._confidentialDecimals = decimals_ <= 6 ? decimals_ : 6;
        $._conversionRate = decimals_ > 6 ? 10 ** (decimals_ - 6) : 1;
    }

    // =========================================================================
    //  ERC-165
    // =========================================================================

    function supportsInterface(bytes4 interfaceId) public view virtual override(IERC165, ERC165Upgradeable) returns (bool) {
        return
            interfaceId == type(IERC20Confidential).interfaceId ||
            interfaceId == type(IFHERC20).interfaceId ||
            interfaceId == type(IERC7984).interfaceId ||
            interfaceId == type(IERC20).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    // =========================================================================
    //  Metadata
    // =========================================================================

    function name() public view virtual override(ERC20Upgradeable, IERC7984) returns (string memory) {
        return super.name();
    }

    function symbol() public view virtual override(ERC20Upgradeable, IERC7984) returns (string memory) {
        return super.symbol();
    }

    function decimals() public view virtual override(ERC20Upgradeable, IERC7984) returns (uint8) {
        return _getERC20ConfidentialStorage()._decimals;
    }

    function confidentialDecimals() public view virtual returns (uint8) {
        return _getERC20ConfidentialStorage()._confidentialDecimals;
    }

    function contractURI() public view virtual returns (string memory) {
        return "";
    }

    function indicatorToken() public view virtual returns (ERC20ConfidentialIndicator) {
        return _getERC20ConfidentialStorage()._indicatorToken;
    }

    /// @dev `false` because {balanceOf} returns the real public ERC-20 balance, not an indicator.
    function balanceOfIsIndicator() public pure virtual returns (bool) {
        return false;
    }

    /// @dev Always `0`: {balanceOf} is not an indicator on this token.
    function indicatorTick() public pure virtual returns (uint256) {
        return 0;
    }

    /// @dev Pegged to {CONFIDENTIAL_POOL}'s public balance, refreshed by {_update} whenever
    /// public tokens enter or leave the pool. Made publicly decryptable.
    function confidentialTotalSupply() public view virtual returns (euint64) {
        return _getERC20ConfidentialStorage()._confidentialTotalSupply;
    }

    function confidentialBalanceOf(address account) public view virtual returns (euint64) {
        return _getERC20ConfidentialStorage()._confidentialBalances[account];
    }

    function isOperator(address holder, address spender) public view virtual returns (bool) {
        return holder == spender || block.timestamp <= _getERC20ConfidentialStorage()._operators[holder][spender];
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
        return _unshield(FHE.asEuint64(amount), amount);
    }

    function unshield(euint64 amount) public virtual returns (euint64) {
        if (!FHE.isAllowed(amount, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        }
        return _unshield(amount, 0);
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

    function confidentialTransfer(address to, InEuint64 memory inValue) public virtual returns (euint64 transferred) {
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

    function confidentialTransferAndCall(
        address to,
        euint64 amount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(amount, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        }
        transferred = _confidentialTransferAndCall(msg.sender, to, amount, data);
        FHE.allowTransient(transferred, msg.sender);
    }

    function confidentialTransferAndCall(
        address to,
        InEuint64 memory encryptedAmount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        transferred = _confidentialTransferAndCall(msg.sender, to, FHE.asEuint64(encryptedAmount), data);
        FHE.allowTransient(transferred, msg.sender);
    }

    function confidentialTransferFromAndCall(
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(amount, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        }
        if (!isOperator(from, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        }
        transferred = _confidentialTransferAndCall(from, to, amount, data);
        FHE.allowTransient(transferred, msg.sender);
    }

    function confidentialTransferFromAndCall(
        address from,
        address to,
        InEuint64 memory encryptedAmount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!isOperator(from, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        }
        transferred = _confidentialTransferAndCall(from, to, FHE.asEuint64(encryptedAmount), data);
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

    /// @dev Refresh {_confidentialTotalSupply} whenever public tokens enter or leave the pool.
    function _update(address from, address to, uint256 value) internal virtual override {
        super._update(from, to, value);

        if (to == CONFIDENTIAL_POOL || from == CONFIDENTIAL_POOL) {
            euint64 newSupply = FHE.asEuint64(SafeCast.toUint64(balanceOf(CONFIDENTIAL_POOL) / _rate()));
            FHE.allowThis(newSupply);
            FHE.allowPublic(newSupply);
            _getERC20ConfidentialStorage()._confidentialTotalSupply = newSupply;
        }
    }

    function _confidentialTransfer(
        address from,
        address to,
        euint64 value
    ) internal virtual returns (euint64 transferred) {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        transferred = _confidentialUpdate(from, to, value);
    }

    function _confidentialTransferAndCall(
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) internal virtual returns (euint64 transferred) {
        euint64 sent = _confidentialTransfer(from, to, amount);
        ebool success = FHERC20Utils.checkOnTransferReceived(msg.sender, from, to, sent, data);
        euint64 refund = _confidentialUpdate(to, from, FHE.select(success, FHE.asEuint64(0), sent));
        transferred = FHE.sub(sent, refund);
    }

    function _unshield(euint64 amount, uint64 requestedAmount) internal virtual returns (euint64 burned) {
        burned = _confidentialUpdate(msg.sender, address(0), amount);
        FHE.allowPublic(burned);
        _createClaim(msg.sender, requestedAmount, burned);
        emit TokensUnshielded(msg.sender, burned);
    }

    function _confidentialUpdate(
        address from,
        address to,
        euint64 amount
    ) internal virtual returns (euint64 transferred) {
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        ebool success;
        euint64 ptr;

        if (from != address(0)) {
            euint64 fromBalance = $._confidentialBalances[from];
            (success, ptr) = FHESafeMath.tryDecrease(fromBalance, amount);
            FHE.allowThis(ptr);
            FHE.allow(ptr, from);
            $._confidentialBalances[from] = ptr;
        }

        transferred = from != address(0) ? FHE.select(success, amount, FHE.asEuint64(0)) : amount;

        if (to != address(0)) {
            ptr = FHE.add($._confidentialBalances[to], transferred);
            FHE.allowThis(ptr);
            FHE.allow(ptr, to);
            $._confidentialBalances[to] = ptr;
        }

        if (from != address(0)) FHE.allow(transferred, from);
        if (to != address(0)) FHE.allow(transferred, to);
        FHE.allowThis(transferred);

        $._indicatorToken.emitConfidentialTransfer(from, to);

        emit ConfidentialTransfer(from, to, transferred);
    }

    function _setOperator(address holder, address operator, uint48 until) internal virtual {
        _getERC20ConfidentialStorage()._operators[holder][operator] = until;
        emit OperatorSet(holder, operator, until);
    }

    function _rate() internal view virtual returns (uint256) {
        return _getERC20ConfidentialStorage()._conversionRate;
    }
}
