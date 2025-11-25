// SPDX-License-Identifier: MIT

pragma solidity ^0.8.20;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { FHE, euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20Confidential } from "./IERC20Confidential.sol";
import { ERC20ConfidentialIndicator } from "./ERC20ConfidentialIndicator.sol";

/**
 * @title ERC20Confidential
 * @dev Extension of ERC20 to support confidential balance and transfers
 *
 * This contract provides dual-balance functionality:
 * - Standard ERC20 balances and transfers (public)
 * - Confidential balances and transfers (encrypted)
 * - Wrap/unwrap functionality to convert between public and confidential tokens
 *
 * The confidential pool is represented by a fixed address where wrapped tokens are stored.
 */
abstract contract ERC20Confidential is ERC20, IERC20Confidential {
    // Fixed address representing the confidential token pool (using confidential tag)
    address private constant CONFIDENTIAL_POOL = address(0x1011000000000000000000000000000000000000);

    // Mapping for confidential balances (encrypted)
    mapping(address => euint64) private _confidentialBalances;

    // Operator system for confidentialTransferFrom
    mapping(address => mapping(address => uint48)) private _operators;

    // Indicator token for showing confidential activity
    ERC20ConfidentialIndicator public immutable indicatorToken;

    // Unwrap claim system - only one claim per user at a time
    struct UnwrapClaim {
        uint256 ctHash;
        uint64 requestedAmount;
        uint64 decryptedAmount;
        bool decrypted;
        bool claimed;
    }

    mapping(address => UnwrapClaim) private _userUnwrapClaims;

    /**
     * @dev Constructor that deploys the indicator token
     */
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        // Deploy the indicator token
        indicatorToken = new ERC20ConfidentialIndicator(address(this), name_, symbol_);
    }

    /**
     * @dev Unauthorized use of encrypted amount.
     */
    error ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(euint64 value, address user);

    /**
     * @dev Unauthorized spender for confidential transfer.
     */
    error ERC20ConfidentialUnauthorizedSpender(address holder, address spender);

    /**
     * @dev Unwrap claim not found.
     */
    error UnwrapClaimNotFound();

    /**
     * @dev Unwrap claim already claimed.
     */
    error UnwrapClaimAlreadyClaimed();

    /**
     * @dev User already has an active unwrap claim.
     */
    error UserHasActiveUnwrapClaim();

    /**
     * @dev Amount too small for confidential precision.
     */
    error AmountTooSmallForConfidentialPrecision();

    /**
     * @dev Returns the confidential balance of an account (encrypted)
     */
    function confidentialBalanceOf(address account) public view virtual override returns (euint64) {
        return _confidentialBalances[account];
    }

    /**
     * @dev Returns true if `spender` is currently an operator for `holder`
     */
    function isOperator(address holder, address spender) public view virtual override returns (bool) {
        return holder == spender || block.timestamp <= _operators[holder][spender];
    }

    /**
     * @dev Returns the number of decimals used for the confidential (encrypted) state.
     * If public decimals <= 6, matches public decimals to avoid precision loss.
     * If public decimals > 6, uses 6 decimals to fit safely within euint64.
     */
    function confidentialDecimals() public view virtual returns (uint8) {
        uint8 pubDec = decimals();
        return pubDec <= 6 ? pubDec : 6;
    }

    /**
     * @dev Wrap public tokens to confidential tokens
     * Transfers tokens from the caller's public balance to the confidential pool
     */
    function wrap(uint256 amount) public virtual override {
        uint256 rate = _rate();

        uint256 amountToWrap = amount - (amount % rate);
        if (amountToWrap == 0) {
            revert AmountTooSmallForConfidentialPrecision();
        }

        uint64 amountConfidential = SafeCast.toUint64(amountToWrap / rate);

        _transfer(msg.sender, CONFIDENTIAL_POOL, amountToWrap);

        _confidentialUpdate(address(0), msg.sender, FHE.asEuint64(amountConfidential));

        emit TokensWrapped(msg.sender, amountToWrap);
    }

    /**
     * @dev Unwrap confidential tokens to public tokens
     * Burns confidential tokens and creates a claim that can be redeemed after decryption
     */
    function unwrap(uint64 amount) public virtual override {
        // Check if user already has an active unwrap claim
        UnwrapClaim memory existingClaim = _userUnwrapClaims[msg.sender];
        if (existingClaim.ctHash != 0 && !existingClaim.claimed) revert UserHasActiveUnwrapClaim();

        // Burn confidential tokens from sender
        euint64 burned = _confidentialUpdate(msg.sender, address(0), FHE.asEuint64(amount));

        // Call FHE.decrypt to initiate decryption
        FHE.decrypt(burned);

        // Create unwrap claim
        _createUnwrapClaim(msg.sender, amount, burned);

        emit TokensUnwrapped(msg.sender, euint64.unwrap(burned));
    }

    /**
     * @dev Claim unwrapped tokens after decryption is complete
     */
    function claimUnwrapped() public virtual override {
        UnwrapClaim memory claim = _handleUnwrapClaim(msg.sender);

        // Scale Up: Private Amount -> Public Amount
        uint256 amountPublic = uint256(claim.decryptedAmount) * _rate();

        // Transfer tokens from confidential pool to sender
        _transfer(CONFIDENTIAL_POOL, msg.sender, amountPublic);

        emit UnwrappedTokensClaimed(msg.sender, amountPublic);
    }

    /**
     * @dev Transfer confidential tokens to another account
     */
    function confidentialTransfer(address to, euint64 value) public virtual override returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        transferred = _confidentialTransfer(msg.sender, to, value);
    }

    /**
     * @dev Transfer confidential tokens to another account (with InEuint64 input)
     */
    function confidentialTransfer(
        address to,
        InEuint64 memory inValue
    ) public virtual override returns (euint64 transferred) {
        euint64 value = FHE.asEuint64(inValue);
        transferred = _confidentialTransfer(msg.sender, to, value);
    }

    /**
     * @dev Transfer confidential tokens from one account to another (with operator approval)
     */
    function confidentialTransferFrom(
        address from,
        address to,
        euint64 value
    ) public virtual override returns (euint64 transferred) {
        if (!FHE.isAllowed(value, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(value, msg.sender);
        }
        if (!isOperator(from, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        }
        transferred = _confidentialTransfer(from, to, value);
    }

    /**
     * @dev Transfer confidential tokens from one account to another (with InEuint64 input)
     */
    function confidentialTransferFrom(
        address from,
        address to,
        InEuint64 memory inValue
    ) public virtual override returns (euint64 transferred) {
        if (!isOperator(from, msg.sender)) {
            revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        }
        euint64 value = FHE.asEuint64(inValue);
        transferred = _confidentialTransfer(from, to, value);
    }

    /**
     * @dev Set an operator for confidential transfers
     */
    function setOperator(address operator, uint48 until) public virtual override {
        _setOperator(msg.sender, operator, until);
    }

    function _confidentialTransfer(
        address from,
        address to,
        euint64 value
    ) internal virtual returns (euint64 transferred) {
        if (from == address(0)) revert ERC20InvalidSender(address(0));
        if (to == address(0)) revert ERC20InvalidReceiver(address(0));
        transferred = _confidentialUpdate(from, to, value);
    }

    /**
     * @dev Internal function to update confidential balances
     */
    function _confidentialUpdate(
        address from,
        address to,
        euint64 value
    ) internal virtual returns (euint64 transferred) {
        // If `value` is greater than the user's encBalance, it is replaced with 0
        // The transaction will succeed, but the amount transferred may be 0
        // Both `from` and `to` will have their `encBalance` updated in either case to preserve confidentiality
        //
        // NOTE: If the function is `_mint`, `from` is the zero address, and does not have an `encBalance` to
        //       compare against, so this check is skipped.
        if (from != address(0)) {
            transferred = FHE.select(value.lte(_confidentialBalances[from]), value, FHE.asEuint64(0));
        } else {
            transferred = value;
        }

        // Only update the balance if the from address is not the zero address (not minting)
        if (from != address(0)) {
            _confidentialBalances[from] = FHE.sub(_confidentialBalances[from], transferred);
        }

        // Only update the balance if the to address is not the zero address (not burning)
        if (to != address(0)) {
            _confidentialBalances[to] = FHE.add(_confidentialBalances[to], transferred);
        }

        // Update CoFHE Access Control List (ACL) to allow decrypting / sealing of the new balances
        if (from != address(0) && euint64.unwrap(_confidentialBalances[from]) != 0) {
            FHE.allowThis(_confidentialBalances[from]);
            FHE.allow(_confidentialBalances[from], from);
            FHE.allow(transferred, from);
        }
        if (to != address(0) && euint64.unwrap(_confidentialBalances[to]) != 0) {
            FHE.allowThis(_confidentialBalances[to]);
            FHE.allow(_confidentialBalances[to], to);
            FHE.allow(transferred, to);
        }

        // Allow the caller to decrypt the transferred amount
        FHE.allow(transferred, msg.sender);

        // Emit Transfer event from indicator token
        indicatorToken.emitConfidentialTransfer(from, to);

        emit ConfidentialTransfer(from, to, euint64.unwrap(transferred));
    }

    /**
     * @dev Internal function to set an operator
     */
    function _setOperator(address holder, address operator, uint48 until) internal virtual {
        _operators[holder][operator] = until;
        emit OperatorSet(holder, operator, until);
    }

    /**
     * @dev Calculates the conversion rate between public and private decimals.
     * Example: 18 public vs 6 private = 1e12 rate.
     */
    function _rate() internal view virtual returns (uint256) {
        uint8 pubDec = decimals();
        if (pubDec > 6) {
            return 10 ** (pubDec - 6);
        }
        return 1;
    }

    /**
     * @dev Internal function to create an unwrap claim
     */
    function _createUnwrapClaim(address to, uint64 value, euint64 claimable) internal {
        _userUnwrapClaims[to] = UnwrapClaim({
            ctHash: euint64.unwrap(claimable),
            requestedAmount: value,
            decryptedAmount: 0,
            decrypted: false,
            claimed: false
        });
    }

    /**
     * @dev Internal function to handle a user's unwrap claim
     */
    function _handleUnwrapClaim(address user) internal returns (UnwrapClaim memory claim) {
        claim = _userUnwrapClaims[user];

        // Check that the claim exists and has not been claimed yet
        if (claim.ctHash == 0) revert UnwrapClaimNotFound();
        if (claim.claimed) revert UnwrapClaimAlreadyClaimed();

        // Get the decrypted amount (reverts if the amount is not decrypted yet)
        uint64 amount = SafeCast.toUint64(FHE.getDecryptResult(claim.ctHash));

        // Update the claim
        claim.decryptedAmount = amount;
        claim.decrypted = true;
        claim.claimed = true;

        // Update the claim in storage
        _userUnwrapClaims[user] = claim;
    }

    /**
     * @dev Get the unwrap claim for a user
     */
    function getUserUnwrapClaim(address user) public view returns (UnwrapClaim memory) {
        UnwrapClaim memory claim = _userUnwrapClaims[user];
        if (claim.ctHash != 0) {
            (uint256 amount, bool decrypted) = FHE.getDecryptResultSafe(claim.ctHash);
            claim.decryptedAmount = SafeCast.toUint64(amount);
            claim.decrypted = decrypted;
        }
        return claim;
    }
}
