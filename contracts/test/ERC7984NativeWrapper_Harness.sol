// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

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
        ERC7984(name_, symbol_, 0, contractURI_)
        ERC7984NativeWrapper(weth_)
    {}
}
