// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ERC20ConfidentialIndicator
 * @dev Synthetic token that shows indicated balances for confidential operations.
 *
 * Designed to be added to wallets and block explorers to show confidential activity
 * without exposing real amounts. All standard ERC-20 operations revert; only the parent
 * ERC20Confidential contract can trigger indicator updates.
 */
contract ERC20ConfidentialIndicator is ERC20 {
    /// @dev Offset applied to every ACTIVE account's indicated balance, so a wallet renders the
    /// brand marker (`1011000.xxxx` at 4 decimals) with the fractional digits carrying activity.
    uint256 private constant _MARKER = 10110000000;
    uint256 private constant _ON_FIRST_RECEIVE = 5001;
    uint256 private constant _ON_FIRST_SEND = 4999;
    uint256 private constant _MAX_INDICATED = 9999;
    uint256 private constant _MIN_INDICATED = 1;

    address public immutable parent;
    mapping(address => uint256) private _indicatedBalances;

    /// @dev Accounts with a nonzero indicated balance, and the running sum of those balances.
    /// Together they make {totalSupply} exactly `sum(balanceOf(x))` (see {totalSupply}).
    uint256 private _activeAccounts;
    uint256 private _indicatedSum;

    error ERC20ConfidentialIndicatorNoOp();
    error ERC20ConfidentialIndicatorOnlyParent();

    modifier onlyParent() {
        if (msg.sender != parent) {
            revert ERC20ConfidentialIndicatorOnlyParent();
        }
        _;
    }

    constructor(
        address parentAddress,
        string memory parentName,
        string memory parentSymbol
    ) ERC20(string.concat("1011000 ", parentName), string.concat("c", parentSymbol)) {
        parent = parentAddress;
    }

    function decimals() public pure override returns (uint8) {
        return 4;
    }

    /**
     * @dev Indicated balance for `account`, or 0 if it has never taken part in a confidential
     * operation.
     *
     * The marker offset applies only to ACTIVE accounts. Returning it for every address would
     * make `balanceOf(x) > 0` true for all 2^160 of them — so any generic "holds the token"
     * eligibility check would pass universally — and would make `totalSupply() ==
     * sum(balanceOf(x))` unsatisfiable at any value, since the sum would be unbounded
     * (Consensys Diligence 5.18). This matches {FHERC20Core-balanceOf}, whose indicator has
     * always returned 0 for untouched accounts.
     */
    function balanceOf(address account) public view override returns (uint256) {
        uint256 indicated = _indicatedBalances[account];
        return indicated == 0 ? 0 : _MARKER + indicated;
    }

    /**
     * @dev Exactly `sum(balanceOf(x))` over every address: each active account contributes the
     * marker plus its indicated balance, and inactive accounts contribute nothing.
     *
     * The inherited ERC-20 `_totalSupply` is permanently 0 here — `_mint`/`_burn` are never
     * reached, since every mutative path reverts and {emitConfidentialTransfer} writes only to
     * `_indicatedBalances` — so it is replaced rather than maintained.
     */
    function totalSupply() public view override returns (uint256) {
        return _activeAccounts * _MARKER + _indicatedSum;
    }

    /// @dev Marks `balanceOf` as an activity indicator rather than a ledger balance, matching
    /// {IFHERC20-balanceOfIsIndicator} on the confidential tokens this mirrors. Consumers that
    /// check it can avoid treating these values as amounts.
    function balanceOfIsIndicator() public pure returns (bool) {
        return true;
    }

    /// @dev Smallest indicated-balance step, in this token's own units: one confidential
    /// operation moves an account's balance by exactly this much.
    function indicatorTick() public pure returns (uint256) {
        return 1;
    }

    function _incrementIndicatedBalance(address account) internal returns (uint256) {
        uint256 current = _indicatedBalances[account];

        if (current == 0) {
            _indicatedBalances[account] = _ON_FIRST_RECEIVE;
            _activeAccounts += 1;
            _indicatedSum += _ON_FIRST_RECEIVE;
            return _ON_FIRST_RECEIVE;
        }

        if (current != _MAX_INDICATED) {
            _indicatedBalances[account] = current + 1;
            _indicatedSum += 1;
            return current + 1;
        }

        return current; // clamped at the ceiling; nothing to account for
    }

    function _decrementIndicatedBalance(address account) internal returns (uint256) {
        uint256 current = _indicatedBalances[account];

        if (current == 0) {
            _indicatedBalances[account] = _ON_FIRST_SEND;
            _activeAccounts += 1;
            _indicatedSum += _ON_FIRST_SEND;
            return _ON_FIRST_SEND;
        }

        if (current != _MIN_INDICATED) {
            _indicatedBalances[account] = current - 1;
            _indicatedSum -= 1;
            return current - 1;
        }

        return current; // clamped at the floor; an account never returns to inactive
    }

    /**
     * @dev Records one confidential operation. `from`/`to` may be the zero address (a confidential
     * mint or an unshield), and those legs are skipped: the zero address is not an account, and
     * counting it would put a phantom holder into {totalSupply} and report a balance for it.
     */
    function emitConfidentialTransfer(address from, address to) public onlyParent {
        if (to != address(0)) _incrementIndicatedBalance(to);
        if (from != address(0)) _decrementIndicatedBalance(from);
        emit Transfer(from, to, _MARKER + 1);
    }

    // ========== REVERTING FUNCTIONS ==========

    function transfer(address, uint256) public pure override returns (bool) {
        revert ERC20ConfidentialIndicatorNoOp();
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert ERC20ConfidentialIndicatorNoOp();
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert ERC20ConfidentialIndicatorNoOp();
    }

    function allowance(address, address) public pure override returns (uint256) {
        revert ERC20ConfidentialIndicatorNoOp();
    }
}
