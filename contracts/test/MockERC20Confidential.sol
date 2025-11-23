// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20Confidential } from "../extensions/ERC20Confidential.sol";

/**
 * @title MockERC20Confidential
 * @dev Mock implementation of ERC20Confidential for testing purposes
 */
contract MockERC20Confidential is ERC20Confidential {
    constructor(string memory name, string memory symbol) ERC20Confidential(name, symbol) {}

    /**
     * @dev Mint new public tokens for testing
     */
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
