// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ERC20Confidential } from "../ERC20Confidential/ERC20Confidential.sol";

/**
 * @dev Mock implementation of ERC20Confidential for testing purposes with configurable decimals.
 */
contract MockERC20Confidential is ERC20Confidential {
    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_
    ) ERC20Confidential(name, symbol, decimals_) {}

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
