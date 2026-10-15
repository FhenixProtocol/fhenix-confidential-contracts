// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { ERC20ConfidentialLib } from "../../ERC20Confidential/ERC20ConfidentialLib.sol";
import { FHERC20InvalidReceiver, FHERC20UnauthorizedSpender } from "./FHERC20Errors.sol";

/**
 * @dev Thin shared claim bookkeeping for {FHERC20} wrapper contracts, over the linked
 * {ERC20ConfidentialLib} claim store (delegatecall'd; hosts must link the library).
 *
 * Replaces the ctHash-keyed `FHERC20WrapperClaimHelper(Upgradeable)` pair: claims are keyed by a
 * UNIQUE per-claimant id — `keccak256(to, nonce++, handle)` — instead of the ciphertext handle.
 * CoFHE handles are content-addressed (no per-caller/per-call salt), so identical burned-amount
 * lineages yield identical handles; handle-keyed claims could therefore overwrite each other and
 * redirect payouts. The handle is retained as `Claim.ctHash` to bind the decryption proof.
 *
 * Storage lives in the SAME ERC-7201 slot the old helpers used
 * (`fherc20.storage.FHERC20WrapperClaimHelper`) but records are NOT layout-compatible (new key
 * derivation, leading `id` field) — pending claims do not survive an upgrade from the old helpers.
 */
abstract contract FHERC20WrapperClaims {
    // Mirrors of the library's errors so they appear in the host ABI (the library reverts them
    // under delegatecall; same names → same selectors).
    error ClaimNotFound();
    error AlreadyClaimed();
    error ClaimBatchLengthMismatch();
    error InvalidDecryptionProof();

    /// @notice Emitted when a pending claim is re-pointed at a new recipient.
    event ClaimReassigned(bytes32 indexed id, address indexed previousTo, address indexed newTo);

    /// @dev Host-supplied operator check, so the claim-owner gate below honours the same operator
    /// rules the rest of the token uses. An internal hook rather than a re-declaration of the
    /// host's public `isOperator`, which would force every wrapper core inheriting both this and
    /// {FHERC20Core} to write an explicit `override(...)` disambiguation.
    function _isClaimOperator(address holder, address spender) internal view virtual returns (bool);

    /// @notice Pending-claim views, keyed by the unique claim id (NOT the ciphertext handle).
    function getClaim(bytes32 id) public view returns (ERC20ConfidentialLib.Claim memory) {
        return ERC20ConfidentialLib.getClaim(id);
    }

    function getUserClaims(address user) public view returns (ERC20ConfidentialLib.Claim[] memory) {
        return ERC20ConfidentialLib.getUserClaims(user);
    }

    /**
     * @notice Re-points an unsettled claim at `newTo`. Callable by the claim's current recipient
     * or an operator acting for them.
     *
     * A claim's recipient is fixed at burn time and settlement pays that address unconditionally,
     * so a recipient that cannot accept the payout — a contract with no payable fallback on a
     * native wrapper, a blocklisted address on an ERC-20 wrapper — would otherwise strand the
     * burned value in the wrapper forever (Consensys Diligence 5.13). Reassignment is the escape
     * hatch: the value is already the recipient's, so only the recipient may redirect it.
     *
     * The claim keeps its id, so a decryption proof obtained before the reassignment stays valid.
     */
    function reassignClaim(bytes32 id, address newTo) public virtual {
        if (newTo == address(0)) revert FHERC20InvalidReceiver(newTo);

        address previousTo = ERC20ConfidentialLib.getClaim(id).to;
        if (previousTo == address(0)) revert ClaimNotFound();
        _checkClaimRecipient(previousTo);

        ERC20ConfidentialLib.reassignClaim(id, newTo);
        emit ClaimReassigned(id, previousTo, newTo);
    }

    /// @dev Reverts unless the caller is `to` or an operator acting for `to`.
    function _checkClaimRecipient(address to) internal view {
        if (!_isClaimOperator(to, msg.sender)) revert FHERC20UnauthorizedSpender(to, msg.sender);
    }

    /// @dev Records a pending claim; returns its unique id.
    function _createClaim(address to, euint64 claimable) internal returns (bytes32 id) {
        return ERC20ConfidentialLib.createClaim(to, claimable);
    }

    /// @dev Verifies the decryption proof for claim `id` and marks it claimed.
    function _handleClaim(
        bytes32 id,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) internal returns (ERC20ConfidentialLib.Claim memory) {
        return ERC20ConfidentialLib.handleClaim(id, decryptedAmount, decryptionProof);
    }

    /// @dev Batch variant of {_handleClaim}; any invalid element reverts the whole batch.
    function _handleClaimBatch(
        bytes32[] memory ids,
        uint64[] memory decryptedAmounts,
        bytes[] memory decryptionProofs
    ) internal returns (ERC20ConfidentialLib.Claim[] memory claims) {
        if (ids.length != decryptedAmounts.length || ids.length != decryptionProofs.length) {
            revert ClaimBatchLengthMismatch();
        }

        claims = new ERC20ConfidentialLib.Claim[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            claims[i] = ERC20ConfidentialLib.handleClaim(ids[i], decryptedAmounts[i], decryptionProofs[i]);
        }
    }
}
