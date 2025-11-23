// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @title IERC20Confidential
 * @dev Interface for ERC20 tokens with confidential functionality
 */
interface IERC20Confidential {
    /**
     * @dev Returns the confidential balance of an account (encrypted)
     */
    function confidentialBalanceOf(address account) external view returns (euint64);

    /**
     * @dev Returns the number of decimals used for the confidential (encrypted) state.
     */
    function confidentialDecimals() external view returns (uint8);

    /**
     * @dev Returns true if `spender` is currently an operator for `holder`
     */
    function isOperator(address holder, address spender) external view returns (bool);

    /**
     * @dev Transfer confidential tokens to another account
     * @param to The address to transfer to
     * @param value The encrypted amount to transfer
     * @return transferred The actual amount transferred (may be less than requested)
     */
    function confidentialTransfer(address to, euint64 value) external returns (euint64 transferred);

    /**
     * @dev Transfer confidential tokens to another account (with InEuint64 input)
     * @param to The address to transfer to
     * @param inValue The encrypted amount to transfer
     * @return transferred The actual amount transferred (may be less than requested)
     */
    function confidentialTransfer(address to, InEuint64 memory inValue) external returns (euint64 transferred);

    /**
     * @dev Transfer confidential tokens from one account to another (with operator approval)
     * @param from The address to transfer from
     * @param to The address to transfer to
     * @param value The encrypted amount to transfer
     * @return transferred The actual amount transferred (may be less than requested)
     */
    function confidentialTransferFrom(address from, address to, euint64 value) external returns (euint64 transferred);

    /**
     * @dev Transfer confidential tokens from one account to another (with InEuint64 input)
     * @param from The address to transfer from
     * @param to The address to transfer to
     * @param inValue The encrypted amount to transfer
     * @return transferred The actual amount transferred (may be less than requested)
     */
    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory inValue
    ) external returns (euint64 transferred);

    /**
     * @dev Wrap public tokens to confidential tokens
     * @param amount The amount of public tokens to wrap
     */
    function wrap(uint256 amount) external;

    /**
     * @dev Unwrap confidential tokens to public tokens
     * @param amount The amount of confidential tokens to unwrap
     */
    function unwrap(uint64 amount) external;

    /**
     * @dev Set an operator for confidential transfers
     * @param operator The address to set as operator
     * @param until The timestamp until which the operator is valid
     */
    function setOperator(address operator, uint48 until) external;

    /**
     * @dev Claim unwrapped tokens after decryption is complete
     */
    function claimUnwrapped() external;

    /**
     * @dev Emitted when confidential tokens are transferred
     */
    event ConfidentialTransfer(address indexed from, address indexed to, uint256 amountHash);

    /**
     * @dev Emitted when tokens are wrapped (converted from public to confidential)
     */
    event TokensWrapped(address indexed account, uint256 amount);

    /**
     * @dev Emitted when tokens are unwrapped (converted from confidential to public)
     */
    event TokensUnwrapped(address indexed account, uint256 amountHash);

    /**
     * @dev Emitted when unwrapped tokens are claimed
     */
    event UnwrappedTokensClaimed(address indexed account, uint256 amount);

    /**
     * @dev Emitted when an operator is set
     */
    event OperatorSet(address indexed holder, address indexed operator, uint48 until);
}
