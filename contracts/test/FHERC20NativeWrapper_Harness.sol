// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { FHERC20 } from "../FHERC20/FHERC20.sol";
import { FHERC20NativeWrapper } from "../FHERC20/extensions/FHERC20NativeWrapper.sol";

contract FHERC20NativeWrapper_Harness is FHERC20NativeWrapper {
    constructor(
        IWETH weth_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_
    )
        FHERC20(name_, symbol_, _cappedDecimals(weth_), contractURI_)
        FHERC20NativeWrapper(weth_)
    {}

    function _cappedDecimals(IWETH token) private view returns (uint8) {
        uint8 d = IERC20Metadata(address(token)).decimals();
        uint8 max = _maxDecimals();
        return d > max ? max : d;
    }
}
