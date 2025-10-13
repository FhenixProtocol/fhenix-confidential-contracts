// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (token/ERC20/ERC20.sol)

pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Implementation of the {IERC20} interface.
 *
 * This implementation is agnostic to the way tokens are created. This means
 * that a supply mechanism has to be added in a derived contract using {_mint}.
 *
 * TIP: For a detailed writeup see our guide
 * https://forum.openzeppelin.com/t/how-to-implement-erc20-supply-mechanisms/226[How
 * to implement supply mechanisms].
 *
 * The default value of {decimals} is 18. To change this, you should override
 * this function so it returns a different value.
 *
 * We have followed general OpenZeppelin Contracts guidelines: functions revert
 * instead returning `false` on failure. This behavior is nonetheless
 * conventional and does not conflict with the expectations of ERC-20
 * applications.
 *
 * Note: This FHERC20 does not include FHE operations, and is intended to decouple the
 * frontend work from the active CoFHE (FHE Coprocessor) work during development and auditing.
 */
interface IFHERC20 is IERC20, IERC20Metadata {
    /**
     * @dev Emitted when `value_hash` encrypted tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event ConfidentialTransfer(address indexed from, address indexed to, uint256 value_hash);

    /**
     * @dev Emitted when the expiration timestamp for an operator `operator` is updated for a given `holder`.
     * The operator may move any amount of tokens on behalf of the holder until the timestamp `until`.
     */
    event OperatorSet(address indexed holder, address indexed operator, uint48 until);

    /**
     * @dev Returns true if the token is a FHERC20.
     */
    function isFherc20() external view returns (bool);

    /**
     * @dev Returns the name of the token.
     */
    function name() external view returns (string memory);

    /**
     * @dev Returns the symbol of the token, usually a shorter version of the
     * name.
     */
    function symbol() external view returns (string memory);

    /**
     * @dev Returns the number of decimals used to get its user representation.
     * For example, if `decimals` equals `2`, a balance of `505` tokens should
     * be displayed to a user as `5.05` (`505 / 10 ** 2`).
     *
     * Tokens usually opt for a value of 18, imitating the relationship between
     * Ether and Wei. This is the default value returned by this function, unless
     * it's overridden.
     *
     * NOTE: This information is only used for _display_ purposes: it in
     * no way affects any of the arithmetic of the contract, including
     * {IERC20-balanceOf} and {IERC20-transfer}.
     */
    function decimals() external view returns (uint8);

    /**
     * @dev See {IERC20-totalSupply}.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the encrypted total supply.
     */
    function confidentialTotalSupply() external view returns (euint64);

    /**
     * @dev Returns an flag indicating that the external balances returned by
     * `balanceOf` is an indication of the underlying encrypted balance.
     * The value returned is between 0.0000 and 0.9999, and
     * acts as a counter of tokens transfers and changes.
     *
     * Receiving tokens increments this indicator by +0.0001.
     * Sending tokens decrements the indicator by -0.0001.
     */
    function balanceOfIsIndicator() external view returns (bool);

    /**
     * @dev Returns the true size of the indicator tick
     */
    function indicatorTick() external view returns (uint256);

    /**
     * @dev Returns an indicator of the underlying encrypted balance.
     * The value returned is [0](no interaction) / [0.0001 - 0.9999](indicated)
     * Indicator acts as a counter of tokens transfers and changes.
     *
     * Receiving tokens increments this indicator by +0.0001.
     * Sending tokens decrements the indicator by -0.0001.
     *
     * Returned in the decimal expectation of the token.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev See {IERC20-balanceOf}.
     *
     * Returns the euint64 representing the account's true balance (encrypted)
     */
    function confidentialBalanceOf(address account) external view returns (euint64);

    /**
     * @dev Returns true if `spender` is currently an operator for `holder`.
     */
    function isOperator(address holder, address spender) external view returns (bool);

    /**
     * @dev Sets `operator` as an operator for `holder` until the timestamp `until`.
     *
     * NOTE: An operator may transfer any amount of tokens on behalf of a holder while approved.
     */
    function setOperator(address operator, uint48 until) external;

    /**
     * @dev See {IERC20-transfer}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20
     */
    function transfer(address to, uint256 value) external pure returns (bool);

    /**
     * @dev See {IERC20-allowance}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20.
     * Allowances have been removed from FHERC20s to prevent encrypted balance leakage.
     * Allowances have been replaced with an EIP712 permit for each `confidentialTransferFrom`.
     */
    function allowance(address owner, address spender) external pure returns (uint256);

    /**
     * @dev See {IERC20-approve}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20.
     * Allowances have been removed from FHERC20s to prevent encrypted balance leakage.
     * Allowances have been replaced with an EIP712 permit for each `confidentialTransferFrom`.
     */
    function approve(address spender, uint256 value) external pure returns (bool);

    /**
     * @dev See {IERC20-transferFrom}.
     * Always reverts to prevent FHERC20 from being unintentionally treated as an ERC20
     */
    function transferFrom(address from, address to, uint256 value) external pure returns (bool);

    /**
     * @dev See {IERC20-transfer}.
     *
     * Intended to be used as a EOA call with an encrypted input `InEuint64 inValue`.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value`.
     * - `inValue` must be a `InEuint164` to preserve confidentiality.
     */
    function confidentialTransfer(address to, InEuint64 memory inValue) external returns (euint64 transferred);

    /**
     * @dev See {IERC20-transfer}.
     *
     * Intended to be used as part of a contract call.
     * Ensure that `value` is allowed to be used by using `FHE.allow` with this contracts address.
     *
     * Requirements:
     *
     * - `to` cannot be the zero address.
     * - the caller must have a balance of at least `value`.
     * - `value` must be a `euint64` to preserve confidentiality.
     */
    function confidentialTransfer(address to, euint64 value) external returns (euint64 transferred);

    /**
     * @dev See {IERC20-transferFrom}.
     *
     * Requirements:
     *
     * - `from` and `to` cannot be the zero address.
     * - `from` must have a balance of at least `value`.
     * - the caller must have allowance for ``from``'s tokens of at least
     * `value`.
     */
    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory inValues
    ) external returns (euint64 transferred);

    function confidentialTransferFrom(address from, address to, euint64 value) external returns (euint64 transferred);

    function confidentialTransferAndCall(
        address to,
        InEuint64 memory inValue,
        bytes calldata data
    ) external returns (euint64 transferred);

    function confidentialTransferAndCall(
        address to,
        euint64 value,
        bytes calldata data
    ) external returns (euint64 transferred);

    function confidentialTransferFromAndCall(
        address from,
        address to,
        InEuint64 memory inValue,
        bytes calldata data
    ) external returns (euint64 transferred);

    function confidentialTransferFromAndCall(
        address from,
        address to,
        euint64 value,
        bytes calldata data
    ) external returns (euint64 transferred);
}
