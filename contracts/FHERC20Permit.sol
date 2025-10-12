// SPDX-License-Identifier: MIT

pragma solidity ^0.8.25;

import { IFHERC20Permit } from "./interfaces/IFHERC20Permit.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IFHERC20, FHERC20 } from "./FHERC20.sol";
import { IFHERC20Errors } from "./interfaces/IFHERC20Errors.sol";
import { FHE, Utils, euint64, InEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Implementation of the FHERC-20 Permit extension allowing operators  to be made via signatures, as defined in
 * https://eips.ethereum.org/EIPS/eip-2612[ERC-2612].
 *
 * Adds the {permit} method, which can be used to change an account's FHERC-20 operator by
 * presenting a message signed by the account. The token holder account doesn't
 * need to send a transaction, and thus is not required to hold Ether at all.
 */

abstract contract FHERC20Permit is FHERC20, IFHERC20Permit, EIP712, Nonces {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint48 until,uint256 nonce,uint256 deadline)");

    /**
     * @dev Permit deadline has expired.
     * @param deadline Expired deadline of the FHERC20_EIP712_Permit.
     */
    error ERC2612ExpiredSignature(uint256 deadline);

    /**
     * @dev Mismatched signature.
     * @param signer ECDSA recovered signer of the FHERC20_EIP712_Permit.
     * @param owner Owner passed in as part of the FHERC20_EIP712_Permit struct.
     */
    error ERC2612InvalidSigner(address signer, address owner);

    constructor(string memory name) EIP712(name, "1") {}

    function permit(
        address owner,
        address spender,
        uint48 until,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public virtual {
        if (block.timestamp > deadline) {
            revert ERC2612ExpiredSignature(deadline);
        }

        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, until, _useNonce(owner), deadline));

        bytes32 hash = _hashTypedDataV4(structHash);

        address signer = ECDSA.recover(hash, v, r, s);
        if (signer != owner) {
            revert ERC2612InvalidSigner(signer, owner);
        }

        _setOperator(owner, spender, until);
    }

    /**
     * @dev Returns the current nonce for `owner`. This value must be
     * included whenever a signature is generated for {permit}.
     *
     * Every successful call to {permit} increases ``owner``'s nonce by one. This
     * prevents a signature from being used multiple times.
     */
    function nonces(address owner) public view override(IFHERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }

    /**
     * @dev Returns the domain separator used in the encoding of the signature for {permit}, as defined by {EIP712}.
     */
    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() external view virtual returns (bytes32) {
        return _domainSeparatorV4();
    }
}
