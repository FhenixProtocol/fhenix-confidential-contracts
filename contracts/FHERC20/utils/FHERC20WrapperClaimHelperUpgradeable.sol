// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

import { Initializable } from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @dev Upgradeable abstract helper that manages pending unshield claims for {FHERC20} wrapper contracts.
 *
 * Uses ERC-7201 namespaced storage for upgrade safety.
 */
abstract contract FHERC20WrapperClaimHelperUpgradeable is Initializable {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    struct Claim {
        address to;
        bytes32 ctHash;
        uint64 requestedAmount;
        uint64 decryptedAmount;
        bool claimed;
    }

    /// @custom:storage-location erc7201:fherc20.storage.FHERC20WrapperClaimHelper
    struct FHERC20WrapperClaimHelperStorage {
        mapping(bytes32 ctHash => Claim) _claims;
        mapping(address => EnumerableSet.Bytes32Set) _userClaims;
    }

    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.FHERC20WrapperClaimHelper")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant FHERC20WrapperClaimHelperStorageLocation =
        0x90973842d0546f0dce9511f9a89cc80d5315812909eb805129843b5aeeaaae00;

    function _getFHERC20WrapperClaimHelperStorage()
        private
        pure
        returns (FHERC20WrapperClaimHelperStorage storage $)
    {
        assembly {
            $.slot := FHERC20WrapperClaimHelperStorageLocation
        }
    }

    error ClaimNotFound();
    error AlreadyClaimed();
    error LengthMismatch();

    function __FHERC20WrapperClaimHelper_init() internal onlyInitializing {}

    function __FHERC20WrapperClaimHelper_init_unchained() internal onlyInitializing {}

    function _createClaim(address to, uint64 requestedAmount, euint64 claimable) internal {
        FHERC20WrapperClaimHelperStorage storage $ = _getFHERC20WrapperClaimHelperStorage();
        bytes32 unwrappedHash = FHE.unwrap(claimable);
        $._claims[unwrappedHash] = Claim({
            to: to,
            ctHash: unwrappedHash,
            requestedAmount: requestedAmount,
            decryptedAmount: 0,
            claimed: false
        });
        $._userClaims[to].add(unwrappedHash);
    }

    function _handleClaim(
        bytes32 ctHash,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) internal returns (Claim memory claim) {
        FHERC20WrapperClaimHelperStorage storage $ = _getFHERC20WrapperClaimHelperStorage();
        claim = $._claims[ctHash];

        if (claim.to == address(0)) revert ClaimNotFound();
        if (claim.claimed) revert AlreadyClaimed();

        FHE.verifyDecryptResult(FHE.wrapEuint64(ctHash), decryptedAmount, decryptionProof);

        claim.decryptedAmount = decryptedAmount;
        claim.claimed = true;

        $._claims[ctHash] = claim;
        $._userClaims[claim.to].remove(ctHash);
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
        return _getFHERC20WrapperClaimHelperStorage()._claims[ctHash];
    }

    function getUserClaims(address user) public view returns (Claim[] memory userClaims) {
        FHERC20WrapperClaimHelperStorage storage $ = _getFHERC20WrapperClaimHelperStorage();
        bytes32[] memory ctHashes = $._userClaims[user].values();
        userClaims = new Claim[](ctHashes.length);
        for (uint256 i = 0; i < ctHashes.length; i++) {
            userClaims[i] = $._claims[ctHashes[i]];
        }
    }
}
