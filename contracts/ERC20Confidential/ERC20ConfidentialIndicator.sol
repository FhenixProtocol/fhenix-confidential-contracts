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
    address public immutable parent;
    mapping(address => uint256) private _indicatedBalances;

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

    function balanceOf(address account) public view override returns (uint256) {
        return 10110000000 + _indicatedBalances[account];
    }

    function _incrementIndicatedBalance(address account) internal returns (uint256) {
        if (_indicatedBalances[account] == 0) {
            _indicatedBalances[account] = 5001;
        } else if (_indicatedBalances[account] != 9999) {
            _indicatedBalances[account] += 1;
        }
        return _indicatedBalances[account];
    }

    function _decrementIndicatedBalance(address account) internal returns (uint256) {
        if (_indicatedBalances[account] == 0) {
            _indicatedBalances[account] = 4999;
        } else if (_indicatedBalances[account] != 1) {
            _indicatedBalances[account] -= 1;
        }
        return _indicatedBalances[account];
    }

    function emitConfidentialTransfer(address from, address to) public onlyParent {
        _incrementIndicatedBalance(to);
        _decrementIndicatedBalance(from);
        emit Transfer(from, to, 10110000001);
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
