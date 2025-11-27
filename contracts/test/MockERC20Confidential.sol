// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20Confidential } from "../extensions/ERC20Confidential.sol";

/**
 * @title MockERC20Confidential
 * @dev Mock implementation of ERC20Confidential for testing purposes with configurable decimals
 */
contract MockERC20Confidential is ERC20Confidential {
    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_
    ) ERC20Confidential(name, symbol, decimals_) {}

    /**
     * @dev Mint new public tokens for testing
     */
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}


