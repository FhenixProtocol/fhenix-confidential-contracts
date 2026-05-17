// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ERC20ConfidentialUpgradeable } from "../ERC20Confidential/ERC20ConfidentialUpgradeable.sol";

contract ERC20ConfidentialUpgradeable_Harness is ERC20ConfidentialUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(string memory name_, string memory symbol_, uint8 decimals_) public initializer {
        __ERC20Confidential_init(name_, symbol_, decimals_);
    }

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }
}
