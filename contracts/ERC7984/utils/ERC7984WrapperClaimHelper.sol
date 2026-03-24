// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @dev Abstract helper contract that manages pending unshield claims for {ERC7984} wrapper contracts.
 *
 * Provides claim lifecycle management: creation, single/batch handling (with decryption verification),
 * and view functions for querying claim status.
 */
abstract contract ERC7984WrapperClaimHelper {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    struct Claim {
        address to;
        bytes32 ctHash;
        uint64 requestedAmount;
        uint64 decryptedAmount;
        bool claimed;
    }

    mapping(bytes32 ctHash => Claim) private _claims;
    mapping(address => EnumerableSet.Bytes32Set) private _userClaims;

    error ClaimNotFound();
    error AlreadyClaimed();
    error LengthMismatch();

    function _createClaim(address to, uint64 requestedAmount, euint64 claimable) internal {
        bytes32 unwrappedHash = euint64.unwrap(claimable);
        _claims[unwrappedHash] = Claim({
            to: to,
            ctHash: unwrappedHash,
            requestedAmount: requestedAmount,
            decryptedAmount: 0,
            claimed: false
        });
        _userClaims[to].add(unwrappedHash);
    }

    function _handleClaim(
        bytes32 ctHash,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) internal returns (Claim memory claim) {
        claim = _claims[ctHash];

        if (claim.to == address(0)) revert ClaimNotFound();
        if (claim.claimed) revert AlreadyClaimed();

        FHE.verifyDecryptResult(euint64.wrap(ctHash), decryptedAmount, decryptionProof);

        claim.decryptedAmount = decryptedAmount;
        claim.claimed = true;

        _claims[ctHash] = claim;
        _userClaims[claim.to].remove(ctHash);
    }

    function _handleClaimBatch(
        bytes32[] memory ctHashes,
        uint64[] memory decryptedAmounts,
        bytes[] memory decryptionProofs
    ) internal returns (Claim[] memory claims) {
        if (ctHashes.length != decryptedAmounts.length || ctHashes.length != decryptionProofs.length) {
            revert LengthMismatch();
        }

        claims = new Claim[](ctHashes.length);
        for (uint256 i = 0; i < ctHashes.length; i++) {
            claims[i] = _handleClaim(ctHashes[i], decryptedAmounts[i], decryptionProofs[i]);
        }
    }

    function getClaim(bytes32 ctHash) public view returns (Claim memory) {
        return _claims[ctHash];
    }

    function getUserClaims(address user) public view returns (Claim[] memory userClaims) {
        bytes32[] memory ctHashes = _userClaims[user].values();
        userClaims = new Claim[](ctHashes.length);
        for (uint256 i = 0; i < ctHashes.length; i++) {
            userClaims[i] = _claims[ctHashes[i]];
        }
    }
}
