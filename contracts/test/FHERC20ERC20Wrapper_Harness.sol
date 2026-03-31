// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import { FHERC20 } from "../FHERC20/FHERC20.sol";
import { FHERC20ERC20Wrapper } from "../FHERC20/extensions/FHERC20ERC20Wrapper.sol";

contract FHERC20ERC20Wrapper_Harness is FHERC20ERC20Wrapper {
    constructor(
        IERC20 underlying_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_
    )
        FHERC20(name_, symbol_, _cappedDecimals(underlying_), contractURI_)
        FHERC20ERC20Wrapper(underlying_)
    {}

    function _cappedDecimals(IERC20 token) private view returns (uint8) {
        (bool ok, bytes memory data) = address(token).staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        uint8 d = (ok && data.length == 32) ? abi.decode(data, (uint8)) : 18;
        uint8 max = _maxDecimals();
        return d > max ? max : d;
    }
}
