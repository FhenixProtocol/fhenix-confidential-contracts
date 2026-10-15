// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { ERC20Confidential } from "../ERC20Confidential/ERC20Confidential.sol";

/**
 * @dev Mock implementation of ERC20Confidential for testing purposes with configurable decimals.
 */
contract MockERC20Confidential is ERC20Confidential {
    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20Confidential(name, symbol, decimals_) {}

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    /**
     * @dev Test-only UNGUARDED confidential balance movers. Deliberately without `nonReentrant`:
     * they stand in for a future entry point added without the guard, which is the scenario the
     * balance-handle check in `_moveAndCall` exists to catch (Diligence 5.16). Reaching that check
     * through a guarded path is impossible, so a regression test needs a path like this.
     *
     * Harness paths rather than a production entry point, so the tests exercise the check itself
     * and never the reentrancy guard a production path happens to carry.
     */
    function harnessConfidentialBurn(address account, uint64 amount) public {
        _confidentialUpdate(account, address(0), FHE.asEuint64(amount));
    }

    function harnessConfidentialMint(address account, uint64 amount) public {
        _confidentialUpdate(address(0), account, FHE.asEuint64(amount));
    }
}
