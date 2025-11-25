// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Confidential } from "../extensions/ERC20Confidential.sol";

/**
 * @title MockERC20Confidential
 * @dev Mock implementation of ERC20Confidential for testing purposes with configurable decimals
 */
contract MockERC20Confidential is ERC20Confidential {
    uint8 private immutable _CUSTOM_DECIMALS;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20Confidential(name, symbol) {
        _CUSTOM_DECIMALS = decimals_;
    }

    /**
     * @dev Override decimals to return custom value
     */
    function decimals() public view virtual override(ERC20) returns (uint8) {
        return _CUSTOM_DECIMALS;
    }

    /**
     * @dev Mint new public tokens for testing
     */
    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}


