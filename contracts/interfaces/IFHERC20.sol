// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC7984 } from "./IERC7984.sol";

/**
 * @dev Interface for a confidential fungible token standard utilizing the Fhenix FHE library.
 *
 * Extends {IERC20} for backwards compatibility with wallets and block explorers. The ERC-20
 * view functions ({balanceOf}, {totalSupply}) return **indicator values** rather than real
 * balances, and the mutative functions ({transfer}, {transferFrom}, {approve}) revert.
 */
interface IFHERC20 is IERC7984, IERC20 {
    /// @dev Returns `true`, signalling that {balanceOf} returns an indicator, not a real balance.
    function balanceOfIsIndicator() external view returns (bool);

    /// @dev Returns the raw unit size of a single indicator tick (scales with {decimals}).
    function indicatorTick() external view returns (uint256);
}
