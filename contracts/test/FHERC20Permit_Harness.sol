// SPDX-License-Identifier: MIT

pragma solidity ^0.8.25;

import { FHERC20 } from "../FHERC20.sol";
import { FHERC20Permit } from "../FHERC20Permit.sol";

contract FHERC20Permit_Harness is FHERC20Permit {
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) FHERC20(name_, symbol_, decimals_) FHERC20Permit(name_) {}

    function mint(address account, uint64 value) public {
        _mint(account, value);
    }

    function burn(address account, uint64 value) public {
        _burn(account, value);
    }

    function setUserIndicatedBalance(address account, uint16 value) public {
        _indicatedBalances[account] = value;
    }

    function setTotalIndicatedSupply(uint16 value) public {
        _indicatedTotalSupply = value;
    }
}
