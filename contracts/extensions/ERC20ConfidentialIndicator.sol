// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title ERC20ConfidentialIndicator
 * @dev Synthetic token that shows indicated balances for confidential operations
 *
 * This token is designed to be added to wallets and block explorers to show
 * confidential activity without exposing real amounts. All operations revert
 * except for balance queries and internal updates from the main token.
 */
contract ERC20ConfidentialIndicator is ERC20 {
    address public immutable parent;
    mapping(address => uint256) private _indicatedBalances;

    /**
     * @dev Error for ERC20 operations not supported in the indicator token
     */
    error ERC20ConfidentialIndicatorNoOp();

    /**
     * @dev Error for unauthorized access to the indicator token
     */
    error ERC20ConfidentialIndicatorOnlyParent();

    /**
     * @dev Only the main token contract can call certain functions
     */
    modifier onlyParent() {
        if (msg.sender != parent) {
            revert ERC20ConfidentialIndicatorNoOp();
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

    /**
     * @dev Fix number of decimals to 4 for indicated balance display
     */
    function decimals() public pure override returns (uint8) {
        return 4;
    }

    /**
     * @dev Returns the indicated balance with confidential tag + tick
     * This is what wallets and block explorers will see
     */
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
        // Increment indicated balance of to
        _incrementIndicatedBalance(to);

        // Decrement indicated balance of from
        _decrementIndicatedBalance(from);

        // Emit ERC20 Transfer event with value 1011000.0001
        emit Transfer(from, to, 10110000001);
    }

    // ========== REVERTING FUNCTIONS ==========
    // All standard ERC20 operations should revert since this is just an indicator

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
