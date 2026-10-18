// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC7984 } from "./IERC7984.sol";

/**
 * @dev Interface for a confidential fungible token standard utilizing the Fhenix FHE library.
 *
 * Extends {IERC20} for backwards compatibility with wallets and block explorers. Implementations
 * support one of two public ERC-20 ledger modes, distinguished by {balanceOfIsIndicator}:
 *
 * - Indicator mode (`true`): {balanceOf} and {totalSupply} return indicator values rather than real
 *   balances, and incompatible mutative functions such as {transfer}, {transferFrom}, and {approve} revert.
 * - Real-ledger mode (`false`): the token exposes ordinary public ERC-20 balances and mutation methods
 *   alongside its confidential balance layer.
 */
interface IFHERC20 is IERC7984, IERC20 {
    /// @dev Returns whether {balanceOf} exposes an interaction indicator instead of a real public balance.
    function balanceOfIsIndicator() external view returns (bool);

    /// @dev Returns the raw unit size of one indicator tick, or `0` when indicator mode is disabled.
    function indicatorTick() external view returns (uint256);
}
