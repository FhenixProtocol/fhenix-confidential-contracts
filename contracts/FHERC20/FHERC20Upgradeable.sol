// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, InEuint64, ebool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { ContextUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import { ERC165Upgradeable } from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";
import { IERC165 } from "@openzeppelin/contracts/interfaces/IERC165.sol";
import { IFHERC20, IERC7984 } from "../interfaces/IFHERC20.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";
import { FHERC20Utils } from "./utils/FHERC20Utils.sol";

/**
 * @dev Upgradeable implementation of {IFHERC20}.
 *
 * This contract implements a fungible token where balances and transfers are encrypted using the Fhenix CoFHE coprocessor,
 * providing confidentiality to users. Token amounts are stored as encrypted, unsigned integers (`euint64`)
 * that can only be decrypted by authorized parties.
 *
 * This variant is designed to be used behind an upgradeable proxy (UUPS, transparent, beacon, etc.)
 * and follows the OpenZeppelin Initializable pattern — storage is initialised via {__FHERC20_init}
 * rather than a constructor.
 *
 * ERC-20 Compatibility:
 *
 * This contract implements the {IERC20} interface for backwards compatibility with wallets, block explorers,
 * and other ERC-20 tooling. The {balanceOf} and {totalSupply} functions return **indicator values** (not real
 * balances). ERC-20 mutative functions (`transfer`, `transferFrom`, `approve`) revert unconditionally.
 */
abstract contract FHERC20Upgradeable is Initializable, IFHERC20, ContextUpgradeable, ERC165Upgradeable {
    /// @custom:storage-location erc7201:fherc20.storage.FHERC20
    struct FHERC20Storage {
        mapping(address account => euint64) _balances;
        mapping(address account => mapping(address spender => uint48)) _operators;
        euint64 _totalSupply;
        string _name;
        string _symbol;
        uint8 _decimals;
        string _contractURI;
        mapping(address account => uint32) _indicatedBalances;
        uint32 _indicatedTotalSupply;
        uint256 _indicatorTick;
    }

    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.FHERC20")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FHERC20StorageLocation = 0x174ed16d97a61a153aad3a46b164784ea06dfc9084805e63b17bf268e438df00;

    function _getFHERC20Storage() private pure returns (FHERC20Storage storage $) {
        assembly {
            $.slot := FHERC20StorageLocation
        }
    }

    uint32 private constant _INDICATOR_BASE = 79_840_000;
    uint32 private constant _INDICATOR_TRANSFER = 79_840_001;

    /// @dev Emitted when an encrypted amount `encryptedAmount` is requested for disclosure by `requester`.
    event AmountDiscloseRequested(euint64 indexed encryptedAmount, address indexed requester);

    /// @dev The given receiver `receiver` is invalid for transfers.
    error FHERC20InvalidReceiver(address receiver);

    /// @dev The given sender `sender` is invalid for transfers.
    error FHERC20InvalidSender(address sender);

    /// @dev The given holder `holder` is not authorized to spend on behalf of `spender`.
    error FHERC20UnauthorizedSpender(address holder, address spender);

    /// @dev The holder `holder` is trying to send tokens but has a balance of 0.
    error FHERC20ZeroBalance(address holder);

    /**
     * @dev The caller `user` does not have access to the encrypted amount `amount`.
     *
     * NOTE: Try using the equivalent transfer function with an input proof.
     */
    error FHERC20UnauthorizedUseOfEncryptedAmount(euint64 amount, address user);

    /// @dev The given caller `caller` is not authorized for the current operation.
    error FHERC20UnauthorizedCaller(address caller);

    /// @dev Reverts when a cleartext ERC-20 function is called on a confidential token.
    error FHERC20IncompatibleFunction();

    /**
     * @dev Sets the values for {name}, {symbol}, {decimals}, and {contractURI}.
     *
     * This function should be called by the initializer of the implementing contract:
     *
     * ```solidity
     * function initialize(...) public initializer {
     *     __FHERC20_init(name_, symbol_, decimals_, contractURI_);
     * }
     * ```
     */
    function __FHERC20_init(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory contractURI_
    ) internal onlyInitializing {
        __FHERC20_init_unchained(name_, symbol_, decimals_, contractURI_);
    }

    function __FHERC20_init_unchained(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory contractURI_
    ) internal onlyInitializing {
        FHERC20Storage storage $ = _getFHERC20Storage();
        $._name = name_;
        $._symbol = symbol_;
        $._decimals = decimals_;
        $._contractURI = contractURI_;
        $._indicatorTick = decimals_ <= 4 ? 1 : 10 ** (decimals_ - 4);
    }

    // =========================================================================
    //  ERC-165
    // =========================================================================

    /// @inheritdoc ERC165Upgradeable
    function supportsInterface(bytes4 interfaceId) public view virtual override(IERC165, ERC165Upgradeable) returns (bool) {
        return
            interfaceId == type(IFHERC20).interfaceId ||
            interfaceId == type(IERC7984).interfaceId ||
            interfaceId == type(IERC20).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    // =========================================================================
    //  ERC-20 indicator (backwards-compatible view layer)
    // =========================================================================

    function totalSupply() public view virtual returns (uint256) {
        FHERC20Storage storage $ = _getFHERC20Storage();
        return uint256($._indicatedTotalSupply) * $._indicatorTick;
    }

    function balanceOf(address account) public view virtual returns (uint256) {
        FHERC20Storage storage $ = _getFHERC20Storage();
        return uint256($._indicatedBalances[account]) * $._indicatorTick;
    }

    /// @dev Always reverts. Use {confidentialTransfer} instead.
    function transfer(address, uint256) public pure returns (bool) {
        revert FHERC20IncompatibleFunction();
    }

    /// @dev Always reverts. Use {confidentialTransferFrom} instead.
    function transferFrom(address, address, uint256) public pure returns (bool) {
        revert FHERC20IncompatibleFunction();
    }

    /// @dev Always reverts. Use {setOperator} instead.
    function approve(address, uint256) public pure returns (bool) {
        revert FHERC20IncompatibleFunction();
    }

    /// @dev Always reverts. Allowances are replaced by time-bound operators.
    function allowance(address, address) public pure returns (uint256) {
        revert FHERC20IncompatibleFunction();
    }

    /// @dev Returns `true`, signalling that {balanceOf} returns an indicator, not a real balance.
    function balanceOfIsIndicator() public pure virtual returns (bool) {
        return true;
    }

    /// @dev Returns the raw unit size of a single indicator tick (scales with {decimals}).
    function indicatorTick() public view returns (uint256) {
        return _getFHERC20Storage()._indicatorTick;
    }

    /// @dev Resets the caller's indicated balance to `0` (no interaction).
    function resetIndicatedBalance() external {
        _getFHERC20Storage()._indicatedBalances[msg.sender] = 0;
    }

    // =========================================================================
    //  IERC7984 view functions
    // =========================================================================

    /// @inheritdoc IERC7984
    function name() public view virtual returns (string memory) {
        return _getFHERC20Storage()._name;
    }

    /// @inheritdoc IERC7984
    function symbol() public view virtual returns (string memory) {
        return _getFHERC20Storage()._symbol;
    }

    /// @inheritdoc IERC7984
    function decimals() public view virtual returns (uint8) {
        return _getFHERC20Storage()._decimals;
    }

    /// @inheritdoc IERC7984
    function contractURI() public view virtual returns (string memory) {
        return _getFHERC20Storage()._contractURI;
    }

    /// @inheritdoc IERC7984
    function confidentialTotalSupply() public view virtual returns (euint64) {
        return _getFHERC20Storage()._totalSupply;
    }

    /// @inheritdoc IERC7984
    function confidentialBalanceOf(address account) public view virtual returns (euint64) {
        return _getFHERC20Storage()._balances[account];
    }

    /// @inheritdoc IERC7984
    function isOperator(address holder, address spender) public view virtual returns (bool) {
        return holder == spender || block.timestamp <= _getFHERC20Storage()._operators[holder][spender];
    }

    // =========================================================================
    //  IERC7984 mutative functions
    // =========================================================================

    /// @inheritdoc IERC7984
    function setOperator(address operator, uint48 until) public virtual {
        _setOperator(msg.sender, operator, until);
    }

    /// @inheritdoc IERC7984
    function confidentialTransfer(address to, InEuint64 memory encryptedAmount) public virtual returns (euint64) {
        return _transfer(msg.sender, to, FHE.asEuint64(encryptedAmount));
    }

    /// @inheritdoc IERC7984
    function confidentialTransfer(address to, euint64 amount) public virtual returns (euint64) {
        if (!FHE.isAllowed(amount, msg.sender)) revert FHERC20UnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        return _transfer(msg.sender, to, amount);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory encryptedAmount
    ) public virtual returns (euint64 transferred) {
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        transferred = _transfer(from, to, FHE.asEuint64(encryptedAmount));
        FHE.allowTransient(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 amount
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(amount, msg.sender)) revert FHERC20UnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        transferred = _transfer(from, to, amount);
        FHE.allowTransient(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferAndCall(
        address to,
        InEuint64 memory encryptedAmount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        transferred = _transferAndCall(msg.sender, to, FHE.asEuint64(encryptedAmount), data);
        FHE.allowTransient(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferAndCall(
        address to,
        euint64 amount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(amount, msg.sender)) revert FHERC20UnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        transferred = _transferAndCall(msg.sender, to, amount, data);
        FHE.allowTransient(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFromAndCall(
        address from,
        address to,
        InEuint64 memory encryptedAmount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        transferred = _transferAndCall(from, to, FHE.asEuint64(encryptedAmount), data);
        FHE.allowTransient(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFromAndCall(
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(amount, msg.sender)) revert FHERC20UnauthorizedUseOfEncryptedAmount(amount, msg.sender);
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        transferred = _transferAndCall(from, to, amount, data);
        FHE.allowTransient(transferred, msg.sender);
    }

    // =========================================================================
    //  Disclosure
    // =========================================================================

    function requestDiscloseEncryptedAmount(euint64 encryptedAmount) public virtual {
        if (!FHE.isAllowed(encryptedAmount, msg.sender))
            revert FHERC20UnauthorizedUseOfEncryptedAmount(encryptedAmount, msg.sender);

        FHE.allowPublic(encryptedAmount);
        emit AmountDiscloseRequested(encryptedAmount, msg.sender);
    }

    function discloseEncryptedAmount(
        euint64 encryptedAmount,
        uint64 cleartextAmount,
        bytes calldata decryptionProof
    ) public virtual {
        FHE.verifyDecryptResult(encryptedAmount, cleartextAmount, decryptionProof);
        emit AmountDisclosed(encryptedAmount, cleartextAmount);
    }

    // =========================================================================
    //  Internal helpers
    // =========================================================================

    function _setOperator(address holder, address operator, uint48 until) internal virtual {
        _getFHERC20Storage()._operators[holder][operator] = until;
        emit OperatorSet(holder, operator, until);
    }

    function _mint(address to, euint64 amount) internal returns (euint64 transferred) {
        if (to == address(0)) revert FHERC20InvalidReceiver(address(0));
        return _update(address(0), to, amount);
    }

    function _burn(address from, euint64 amount) internal returns (euint64 transferred) {
        if (from == address(0)) revert FHERC20InvalidSender(address(0));
        return _update(from, address(0), amount);
    }

    function _transfer(address from, address to, euint64 amount) internal returns (euint64 transferred) {
        if (from == address(0)) revert FHERC20InvalidSender(address(0));
        if (to == address(0)) revert FHERC20InvalidReceiver(address(0));
        return _update(from, to, amount);
    }

    function _transferAndCall(
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) internal returns (euint64 transferred) {
        euint64 sent = _transfer(from, to, amount);

        ebool success = FHERC20Utils.checkOnTransferReceived(msg.sender, from, to, sent, data);

        euint64 refund = _update(to, from, FHE.select(success, FHE.asEuint64(0), sent));
        transferred = FHE.sub(sent, refund);
    }

    function _incrementIndicator(uint32 current) internal pure returns (uint32) {
        if (current == 0) return _INDICATOR_BASE + 1;
        return current + 1;
    }

    function _decrementIndicator(uint32 current) internal pure returns (uint32) {
        if (current == 0) return _INDICATOR_BASE;
        return current - 1;
    }

    function _update(address from, address to, euint64 amount) internal virtual returns (euint64 transferred) {
        FHERC20Storage storage $ = _getFHERC20Storage();
        ebool success;
        euint64 ptr;

        if (from == address(0)) {
            (success, ptr) = FHESafeMath.tryIncrease($._totalSupply, amount);
            FHE.allowThis(ptr);
            $._totalSupply = ptr;
            $._indicatedTotalSupply = _incrementIndicator($._indicatedTotalSupply);
        } else {
            euint64 fromBalance = $._balances[from];
            if (!FHE.isInitialized(fromBalance)) revert FHERC20ZeroBalance(from);
            (success, ptr) = FHESafeMath.tryDecrease(fromBalance, amount);
            FHE.allowThis(ptr);
            FHE.allow(ptr, from);
            $._balances[from] = ptr;
            $._indicatedBalances[from] = _decrementIndicator($._indicatedBalances[from]);
        }

        transferred = FHE.select(success, amount, FHE.asEuint64(0));

        if (to == address(0)) {
            ptr = FHE.sub($._totalSupply, transferred);
            FHE.allowThis(ptr);
            $._totalSupply = ptr;
            $._indicatedTotalSupply = _decrementIndicator($._indicatedTotalSupply);
        } else {
            ptr = FHE.add($._balances[to], transferred);
            FHE.allowThis(ptr);
            FHE.allow(ptr, to);
            $._balances[to] = ptr;
            $._indicatedBalances[to] = _incrementIndicator($._indicatedBalances[to]);
        }

        if (from != address(0)) FHE.allow(transferred, from);
        if (to != address(0)) FHE.allow(transferred, to);
        FHE.allowThis(transferred);

        emit Transfer(from, to, uint256(_INDICATOR_TRANSFER) * $._indicatorTick);
        emit ConfidentialTransfer(from, to, transferred);
    }
}
