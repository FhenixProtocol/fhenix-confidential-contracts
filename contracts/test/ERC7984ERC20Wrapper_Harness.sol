// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { ERC7984 } from "../ERC7984/ERC7984.sol";
import { ERC7984ERC20Wrapper } from "../ERC7984/extensions/ERC7984ERC20Wrapper.sol";

contract ERC7984ERC20Wrapper_Harness is ERC7984ERC20Wrapper {
    constructor(
        IERC20 underlying_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_
    )
        ERC7984("", "", 0, contractURI_)
        ERC7984ERC20Wrapper(underlying_, name_, symbol_)
    {}

    function updateSymbol(string memory updatedSymbol) public {
        _updateSymbol(updatedSymbol);
    }
}
