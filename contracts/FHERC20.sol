// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (token/ERC20/ERC20.sol)

pragma solidity ^0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import { IFHERC20 } from "./interfaces/IFHERC20.sol";
import { FHERC20Utils } from "./utils/FHERC20Utils.sol";
import { IFHERC20Errors } from "./interfaces/IFHERC20Errors.sol";
import { FHE, Utils, euint64, InEuint64, ebool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Implementation of the {IERC20} interface.
 *
 * This implementation is agnostic to the way tokens are created. This means
 * that a supply mechanism has to be added in a derived contract using {_mint}.
 *
 * TIP: For a detailed writeup see our guide
 * https://forum.openzeppelin.com/t/how-to-implement-erc20-supply-mechanisms/226[How
 * to implement supply mechanisms].
 *
 * The default value of {decimals} is 18. To change this, you should override
 * this function so it returns a different value.
 *
 * We have followed general OpenZeppelin Contracts guidelines: functions revert
 * instead returning `false` on failure. This behavior is nonetheless
 * conventional and does not conflict with the expectations of ERC-20
 * applications.
 *
 * Note: This FHERC20 does not include FHE operations, and is intended to decouple the
 * frontend work from the active CoFHE (FHE Coprocessor) work during development and auditing.
 */
abstract contract FHERC20 is IFHERC20, IFHERC20Errors, Context {
    // NOTE: `indicatedBalances` are intended to indicate movement and change
    // of an encrypted FHERC20 balance, without exposing any encrypted data.
    //
    // !! WARNING !! These indicated balances MUST NOT be used in any FHERC20 logic, only
    // the encrypted balance should be used.
    //
    // `indicatedBalance` is implemented to make FHERC20s maximally backwards
    // compatible with existing ERC20 expectations.
    //
    // `indicatedBalance` is internally represented by a number between 0 and 99999.
    // When viewed in a wallet, it is transformed into a decimal value with 4 digits
    // of precision (0.0000 to 0.9999). These same increments are used as the
    // value in any emitted events. If the user has not interacted with this FHERC20
    // their indicated amount will be 0. Their first interaction will set the amount to
    // the midpoint (0.5000), and each subsequent interaction will shift that value by
    // the increment (0.0001). This gives room for up to 5000 interactions in either
    // direction, which is sufficient for >99.99% of user use cases.
    //
    // These `indicatedBalance` changes will show up in:
    // - transactions and block scanners (0xAAA -> 0xBBB - 0.0001 eETH)
    // - wallets and portfolios (eETH - 0.5538)
    //
    // `indicatedBalance` is included in the FHERC20 standard as a stop-gap
    // to indicate change when the real encrypted change is not yet implemented
    // in infrastructure like wallets and etherscans.
    mapping(address account => uint16) internal _indicatedBalances;
    mapping(address account => euint64) internal _encBalances;
    mapping(address account => mapping(address spender => uint48)) internal _operators;

    uint16 internal _indicatedTotalSupply;
    euint64 internal _encTotalSupply;

    string private _name;
    string private _symbol;
    uint8 private _decimals;
    uint256 private _indicatorTick;

    /**
     * @dev Sets the values for {name} and {symbol}.
     *
     * All two of these values are immutable: they can only be set once during
     * construction.
     */
    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;

        _indicatorTick = decimals_ <= 4 ? 1 : 10 ** (decimals_ - 4);
    }

    /**
     * @dev Returns true if the token is a FHERC20.
     */
    function isFherc20() public view virtual returns (bool) {
        return true;
    }

    /**
     * @dev Returns the name of the token.
     */
    function name() public view virtual returns (string memory) {
        return _name;
    }

    /**
     * @dev Returns the symbol of the token, usually a shorter version of the
     * name.
     */
    function symbol() public view virtual returns (string memory) {
        return _symbol;
    }

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5.05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the default value returned by this function, unless
     * it's overridden.
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC20-balanceOf} and {IERC20-transfer}.
     */
    function decimals() public view virtual returns (uint8) {
        return _decimals;
    }

    /**
     * @dev See {IERC20-totalSupply}.
     *
     * Returns the indicated total supply.
     */
    function totalSupply() public view virtual returns (uint256) {
        return _indicatedTotalSupply * _indicatorTick;
    }

    /**
     * @dev Returns the encrypted total supply.
     */
    function confidentialTotalSupply() public view virtual returns (euint64) {
        return _encTotalSupply;
    }

    /**
     * @dev Returns an flag indicating that the public balances returned by
     * `balanceOf` is an indication of the underlying encrypted balance.
     * The value returned is between 0.0000 and 0.9999, and
     * acts as a counter of tokens transfers and changes.
     *
     * Receiving tokens increments this indicator by +0.0001.
     * Sending tokens decrements the indicator by -0.0001.
     */
    function balanceOfIsIndicator() public view virtual returns (bool) {
        return true;
    }

    /**
     * @dev Returns the true size of the indicator tick
     */
    function indicatorTick() public view returns (uint256) {
        return _indicatorTick;
    }

    /**
     * @dev Returns an indicator of the underlying encrypted balance.
     * The value returned is [0](no interaction) / [0.0001 - 0.9999](indicated)
     * Indicator acts as a counter of tokens transfers and changes.
     *
     * Receiving tokens increments this indicator by +0.0001.
     * Sending tokens decrements the indicator by -0.0001.
     *
     * Returned in the decimal expectation of the token.
     */
    function balanceOf(address account) public view virtual returns (uint256) {
        return _indicatedBalances[account] * _indicatorTick;
    }

    /**
     * @dev See {IERC20-balanceOf}.
     *
     * Returns the euint64 representing the account's true balance (encrypted)
     */
    function confidentialBalanceOf(address account) public view virtual returns (euint64) {
        return _encBalances[account];
    }

    /**
     * @dev Returns true if `spender` is currently an operator for `holder`.
     */
    function isOperator(address holder, address spender) public view virtual returns (bool) {
        return holder == spender || block.timestamp <= _operators[holder][spender];
    }

    /**
     * @dev Sets `operator` as an operator for `holder` until the timestamp `until`.
     *
     * NOTE: An operator may transfer any amount of tokens on behalf of a holder while approved.
     */
    function setOperator(address operator, uint48 until) public virtual {
        _setOperator(msg.sender, operator, until);
    }

    /**
     * @dev See {IERC20-transfer}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20
     */
    function transfer(address, uint256) public pure returns (bool) {
        revert FHERC20IncompatibleFunction();
    }

    /**
     * @dev See {IERC20-allowance}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20.
     * Allowances have been removed from FHERC20s to prevent encrypted balance leakage.
     * Allowances have been replaced with operators for each `confidentialTransferFrom`.
     */
    function allowance(address, address) external pure returns (uint256) {
        revert FHERC20IncompatibleFunction();
    }

    /**
     * @dev See {IERC20-approve}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20.
     * Allowances have been removed from FHERC20s to prevent encrypted balance leakage.
     * Allowances have been replaced with operators for each `confidentialTransferFrom`.
     */
    function approve(address, uint256) external pure returns (bool) {
        revert FHERC20IncompatibleFunction();
    }

    /**
     * @dev See {IERC20-transferFrom}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20
     */
    function transferFrom(address, address, uint256) public pure returns (bool) {
        revert FHERC20IncompatibleFunction();
    }

    /**
     * @dev See {IERC20-transfer}.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value`.
     * - `inValue` must be a `InEuint64` to preserve confidentiality.
     */
    function confidentialTransfer(address to, InEuint64 memory inValue) public virtual returns (euint64 transferred) {
        euint64 value = FHE.asEuint64(inValue);
        transferred = _transfer(msg.sender, to, value);
    }

    function confidentialTransfer(address to, euint64 value) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert FHERC20UnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        transferred = _transfer(msg.sender, to, value);
    }

    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory inValue
    ) public virtual returns (euint64 transferred) {
        if (!isOperator(from, msg.sender)) {
            revert FHERC20UnauthorizedSpender(from, msg.sender);
        }
        euint64 value = FHE.asEuint64(inValue);

        transferred = _transfer(from, to, value);
    }

    function confidentialTransferFrom(
        address from,
        address to,
        euint64 value
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert FHERC20UnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        if (!isOperator(from, msg.sender)) {
            revert FHERC20UnauthorizedSpender(from, msg.sender);
        }
        transferred = _transfer(from, to, value);
    }

    function confidentialTransferAndCall(
        address to,
        InEuint64 memory inValue,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        euint64 value = FHE.asEuint64(inValue);
        transferred = _transferAndCall(msg.sender, to, value, data);
    }

    function confidentialTransferAndCall(
        address to,
        euint64 value,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert FHERC20UnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        transferred = _transferAndCall(msg.sender, to, value, data);
    }

    function confidentialTransferFromAndCall(
        address from,
        address to,
        InEuint64 memory inValue,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!isOperator(from, msg.sender)) {
            revert FHERC20UnauthorizedSpender(from, msg.sender);
        }
        euint64 value = FHE.asEuint64(inValue);

        transferred = _transferAndCall(from, to, value, data);
    }

    function confidentialTransferFromAndCall(
        address from,
        address to,
        euint64 value,
        bytes calldata data
    ) public virtual returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert FHERC20UnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        if (!isOperator(from, msg.sender)) {
            revert FHERC20UnauthorizedSpender(from, msg.sender);
        }
        transferred = _transferAndCall(from, to, value, data);
    }
    /**
     * @dev Moves a `value` amount of tokens from `from` to `to`.
     *
     * This internal function is equivalent to {transfer}, and can be used to
     * e.g. implement automatic token fees, slashing mechanisms, etc.
     *
     * Emits a {Transfer} event.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead.
     */
    function _transfer(address from, address to, euint64 value) internal returns (euint64 transferred) {
        if (from == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        if (to == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        transferred = _update(from, to, value);
    }

    function _transferAndCall(
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) internal returns (euint64 transferred) {
        // Try to transfer amount + replace input with actually transferred amount.
        euint64 sent = _transfer(from, to, amount);

        // Perform callback
        ebool success = FHERC20Utils.checkOnTransferReceived(msg.sender, from, to, sent, data);

        // Try to refund if callback fails
        euint64 refund = _update(to, from, FHE.select(success, FHE.asEuint64(0), sent));
        transferred = FHE.sub(sent, refund);
    }

    /*
     * @dev Increments a user's balance indicator by 0.0001
     */
    function _incrementIndicator(uint16 current) internal pure returns (uint16) {
        if (current == 0 || current == 9999) return 5001;
        return current + 1;
    }

    /*
     * @dev Decrements a user's balance indicator by 0.0001
     */
    function _decrementIndicator(uint16 value) internal pure returns (uint16) {
        if (value == 0 || value == 1) return 4999;
        return value - 1;
    }

    /**
     * @dev Transfers a `value` amount of tokens from `from` to `to`, or alternatively mints (or burns) if `from`
     * (or `to`) is the zero address. All customizations to transfers, mints, and burns should be done by overriding
     * this function.
     *
     * Emits a {Transfer} event and an {ConfidentialTransfer} event which includes the encrypted value.
     */
    function _update(address from, address to, euint64 value) internal virtual returns (euint64 transferred) {
        // If `value` is greater than the user's encBalance, it is replaced with 0
        // The transaction will succeed, but the amount transferred may be 0
        // Both `from` and `to` will have their `encBalance` updated in either case to preserve confidentiality
        //
        // NOTE: If the function is `_mint`, `from` is the zero address, and does not have an `encBalance` to
        //       compare against, so this check is skipped.
        if (from != address(0)) {
            transferred = FHE.select(value.lte(_encBalances[from]), value, FHE.asEuint64(0));
        } else {
            transferred = value;
        }

        if (from == address(0)) {
            _indicatedTotalSupply = _incrementIndicator(_indicatedTotalSupply);
            _encTotalSupply = FHE.add(_encTotalSupply, transferred);
        } else {
            _encBalances[from] = FHE.sub(_encBalances[from], transferred);
            _indicatedBalances[from] = _decrementIndicator(_indicatedBalances[from]);
        }

        if (to == address(0)) {
            _indicatedTotalSupply = _decrementIndicator(_indicatedTotalSupply);
            _encTotalSupply = FHE.sub(_encTotalSupply, transferred);
        } else {
            _encBalances[to] = FHE.add(_encBalances[to], transferred);
            _indicatedBalances[to] = _incrementIndicator(_indicatedBalances[to]);
        }

        // Update CoFHE Access Control List (ACL) to allow decrypting / sealing of the new balances
        if (euint64.unwrap(_encBalances[from]) != 0) {
            FHE.allowThis(_encBalances[from]);
            FHE.allow(_encBalances[from], from);
            FHE.allow(transferred, from);
        }
        if (euint64.unwrap(_encBalances[to]) != 0) {
            FHE.allowThis(_encBalances[to]);
            FHE.allow(_encBalances[to], to);
            FHE.allow(transferred, to);
        }

        // Allow the caller to decrypt the transferred amount
        FHE.allow(transferred, msg.sender);

        // Hide totalSupply
        FHE.allowThis(_encTotalSupply);

        emit Transfer(from, to, _indicatorTick);
        emit ConfidentialTransfer(from, to, euint64.unwrap(transferred));
    }

    /**
     * @dev Creates a `value` amount of tokens and assigns them to `account`, by transferring it from address(0).
     * Relies on the `_update` mechanism
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead.
     */
    function _mint(address account, uint64 value) internal returns (euint64 transferred) {
        if (account == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        transferred = _update(address(0), account, FHE.asEuint64(value));
    }

    /**
     * @dev Destroys a `value` amount of tokens from `account`, lowering the total supply.
     * Relies on the `_update` mechanism.
     *
     * Emits a {Transfer} event with `to` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead
     */
    function _burn(address account, uint64 value) internal returns (euint64 transferred) {
        if (account == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        transferred = _update(account, address(0), FHE.asEuint64(value));
    }

    /**
     * @dev Creates a `value` amount of tokens and assigns them to `account`, by transferring it from address(0).
     * Relies on the `_update` mechanism
     *
     * Emits a {Transfer} event with `from` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead.
     */
    function _confidentialMint(address account, euint64 value) internal returns (euint64 transferred) {
        if (account == address(0)) {
            revert ERC20InvalidReceiver(address(0));
        }
        transferred = _update(address(0), account, value);
    }

    /**
     * @dev Destroys a `value` amount of tokens from `account`, lowering the total supply.
     * Relies on the `_update` mechanism.
     *
     * Emits a {Transfer} event with `to` set to the zero address.
     *
     * NOTE: This function is not virtual, {_update} should be overridden instead
     */
    function _confidentialBurn(address account, euint64 value) internal returns (euint64 transferred) {
        if (account == address(0)) {
            revert ERC20InvalidSender(address(0));
        }
        transferred = _update(account, address(0), value);
    }

    // FHERC20

    function resetIndicatedBalance() external {
        _indicatedBalances[msg.sender] = 0;
    }

    function _setOperator(address holder, address operator, uint48 until) internal virtual {
        _operators[holder][operator] = until;
        emit OperatorSet(holder, operator, until);
    }
}
