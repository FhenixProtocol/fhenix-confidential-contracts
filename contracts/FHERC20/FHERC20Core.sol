// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, externalEuint64, sharedEuint64, ebool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { IFHERC20, IERC7984 } from "../interfaces/IFHERC20.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";
import { FHERC20Utils } from "./utils/FHERC20Utils.sol";
import { FHERC20InvalidReceiver, FHERC20InvalidSender, FHERC20UnauthorizedSpender, FHERC20ZeroBalance, FHERC20UnauthorizedUseOfEncryptedAmount, FHERC20IncompatibleFunction, FHERC20ReceiverMovedBalance, InvalidDecryptionProof } from "./utils/FHERC20Errors.sol";

/**
 * @dev Shared core of the {IFHERC20} reference implementation — the single home of all FHERC20
 * logic, hosted by both the constructor-based {FHERC20} and the proxy-friendly
 * {FHERC20Upgradeable} (which previously each carried a full copy of this code).
 *
 * This contract implements a fungible token where balances and transfers are encrypted using the
 * Fhenix CoFHE coprocessor, providing confidentiality to users. Token amounts are stored as
 * encrypted, unsigned integers (`euint64`) that can only be decrypted by authorized parties.
 *
 * Design notes:
 * - State lives in the SAME ERC-7201 namespaced struct ({FHERC20Storage}, slot
 *   `fherc20.storage.FHERC20`) that {FHERC20Upgradeable} always used, so existing upgradeable
 *   proxies keep their storage across an upgrade to a host built on this core.
 * - Setup is a plain `internal` {__FHERC20Core_init} — the HOST guards one-time initialization
 *   (a constructor for {FHERC20}, an OZ initializer for {FHERC20Upgradeable}).
 * - No OZ bases and no `supportsInterface` here: the hosts bring their own `Context`/`ERC165`
 *   flavor and ERC-165 answers.
 *
 * ERC-20 Compatibility: {balanceOf} and {totalSupply} return **indicator values** (not real
 * balances). The indicator starts at `7984.0000` on first interaction and shifts by `0.0001`
 * per transfer, signalling that this is a confidential token. ERC-20 mutative functions
 * (`transfer`, `transferFrom`, `approve`) revert unconditionally.
 */
abstract contract FHERC20Core is IFHERC20, ReentrancyGuardTransient {
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
    bytes32 private constant FHERC20StorageLocation =
        0x174ed16d97a61a153aad3a46b164784ea06dfc9084805e63b17bf268e438df00;

    function _getFHERC20Storage() private pure returns (FHERC20Storage storage $) {
        assembly {
            $.slot := FHERC20StorageLocation
        }
    }

    uint32 private constant _INDICATOR_BASE = 79_840_000;
    uint32 private constant _INDICATOR_TRANSFER = 79_840_001;

    /// @dev Emitted when an encrypted amount `encryptedAmount` is requested for disclosure by `requester`.
    event AmountDiscloseRequested(euint64 indexed encryptedAmount, address indexed requester);

    /**
     * @dev Sets the values for {name}, {symbol}, {decimals}, and {contractURI}.
     *
     * Plain `internal` — no `Initializable` here. The host guards one-time setup: {FHERC20}
     * calls this from its constructor, {FHERC20Upgradeable} from its `onlyInitializing` init.
     */
    function __FHERC20Core_init(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory contractURI_
    ) internal {
        FHERC20Storage storage $ = _getFHERC20Storage();
        $._name = name_;
        $._symbol = symbol_;
        $._decimals = decimals_;
        $._contractURI = contractURI_;
        $._indicatorTick = decimals_ <= 4 ? 1 : 10 ** (decimals_ - 4);
    }

    // =========================================================================
    //  ERC-20 indicator (backwards-compatible view layer)
    // =========================================================================

    /**
     * @dev Returns an indicator of the underlying encrypted total supply. The value is **not** the
     * real total supply — it is a counter that starts at `7984.0000` on first mint and shifts by
     * `0.0001` per mint/burn.
     */
    function totalSupply() public view virtual returns (uint256) {
        FHERC20Storage storage $ = _getFHERC20Storage();
        return uint256($._indicatedTotalSupply) * $._indicatorTick;
    }

    /**
     * @dev Returns an indicator of the underlying encrypted balance. The value is **not** the real
     * balance — it is a counter that starts at `7984.0001` on first interaction and shifts by
     * `0.0001` per send/receive. A return value of `0` means the account has never interacted.
     */
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
    function confidentialTransfer(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) public virtual nonReentrant returns (sharedEuint64) {
        euint64 transferred = _transfer(msg.sender, to, FHE.asEuint64(encryptedAmount, inputProof));
        return FHE.shareEuint64(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransfer(
        address to,
        sharedEuint64 sharedAmount
    ) public virtual nonReentrant returns (sharedEuint64) {
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        euint64 transferred = _transfer(msg.sender, to, amount);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFrom(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof
    ) public virtual nonReentrant returns (sharedEuint64) {
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        euint64 transferred = _transfer(from, to, FHE.asEuint64(encryptedAmount, inputProof));
        return FHE.shareEuint64(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFrom(
        address from,
        address to,
        sharedEuint64 sharedAmount
    ) public virtual nonReentrant returns (sharedEuint64) {
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        euint64 transferred = _transfer(from, to, amount);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferAndCall(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        euint64 transferred = _transferAndCall(msg.sender, to, FHE.asEuint64(encryptedAmount, inputProof), data);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferAndCall(
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        euint64 transferred = _transferAndCall(msg.sender, to, amount, data);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFromAndCall(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        euint64 transferred = _transferAndCall(from, to, FHE.asEuint64(encryptedAmount, inputProof), data);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    /// @inheritdoc IERC7984
    function confidentialTransferFromAndCall(
        address from,
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        if (!isOperator(from, msg.sender)) revert FHERC20UnauthorizedSpender(from, msg.sender);
        euint64 transferred = _transferAndCall(from, to, amount, data);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    // =========================================================================
    //  Disclosure
    // =========================================================================

    /**
     * @dev Starts the process to disclose an encrypted amount `encryptedAmount` publicly by making it
     * publicly decryptable. Emits the {AmountDiscloseRequested} event.
     *
     * NOTE: Both `msg.sender` and `address(this)` must have permission to access the encrypted amount
     * `encryptedAmount` to request disclosure of the encrypted amount `encryptedAmount`.
     */
    function requestDiscloseEncryptedAmount(euint64 encryptedAmount) public virtual {
        if (!FHE.isAllowed(encryptedAmount, msg.sender))
            revert FHERC20UnauthorizedUseOfEncryptedAmount(encryptedAmount, msg.sender);

        FHE.allowPublic(encryptedAmount);
        emit AmountDiscloseRequested(encryptedAmount, msg.sender);
    }

    /**
     * @dev Publicly discloses an encrypted value with a given decryption proof. Emits the {AmountDisclosed} event.
     *
     * NOTE: May not be tied to a prior request via {requestDiscloseEncryptedAmount}.
     */
    function discloseEncryptedAmount(
        euint64 encryptedAmount,
        uint64 cleartextAmount,
        bytes calldata decryptionProof
    ) public virtual {
        if (!FHE.verifyDecryptResultSafe(encryptedAmount, cleartextAmount, decryptionProof)) {
            revert InvalidDecryptionProof();
        }
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

    /**
     * @dev Credits `to`, asks `to` whether it accepts, and refunds `from` if it does not.
     *
     * Checks the ctHash of the receiver before and after the call to ensure it did not move its own balance.
     * This is a redundant safety check - reentrancy guards on token transfers will revert if the receiver attempts to move its own balance.
     */
    function _transferAndCall(
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) internal returns (euint64 transferred) {
        euint64 sent = _transfer(from, to, amount);

        bytes32 balanceBefore = FHE.unwrap(_getFHERC20Storage()._balances[to]);

        ebool success = FHERC20Utils.checkOnTransferReceived(msg.sender, from, to, sent, data);

        if (FHE.unwrap(_getFHERC20Storage()._balances[to]) != balanceBefore) {
            revert FHERC20ReceiverMovedBalance(to);
        }

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
