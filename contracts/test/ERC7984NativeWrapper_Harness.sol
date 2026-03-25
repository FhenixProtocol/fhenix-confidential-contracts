// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { ERC7984 } from "../ERC7984/ERC7984.sol";
import { ERC7984NativeWrapper } from "../ERC7984/extensions/ERC7984NativeWrapper.sol";

contract ERC7984NativeWrapper_Harness is ERC7984NativeWrapper {
    constructor(
        IWETH weth_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_
    )
        ERC7984(name_, symbol_, _cappedDecimals(weth_), contractURI_)
        ERC7984NativeWrapper(weth_)
    {}

    function _cappedDecimals(IWETH token) private view returns (uint8) {
        uint8 d = IERC20Metadata(address(token)).decimals();
        uint8 max = _maxDecimals();
        return d > max ? max : d;
    }
}
