// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (token/ERC20/ERC20.sol)

pragma solidity ^0.8.25;

import { IERC20, IERC20Metadata, ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { euint64, FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IFHERC20, FHERC20 } from "./FHERC20.sol";
import { FHERC20UnshieldClaim } from "./FHERC20UnshieldClaim.sol";

contract FHERC20WrappedERC20 is FHERC20, Ownable, FHERC20UnshieldClaim {
    using SafeERC20 for IERC20;

    IERC20 private immutable _erc20;
    uint256 private immutable _conversionRate;
    string private _symbol;

    event ShieldedERC20(address indexed from, address indexed to, uint256 value);
    event UnshieldedERC20(address indexed from, address indexed to, uint64 value);
    event ClaimedUnshieldedERC20(address indexed from, address indexed to, uint256 value);
    event SymbolUpdated(string symbol);

    /**
     * @dev The erc20 token couldn't be shielded.
     */
    error FHERC20InvalidErc20(address token);

    /**
     * @dev The recipient is the zero address.
     */
    error InvalidRecipient();

    /**
     * @dev The shielded amount is too small to represent at confidential precision.
     */
    error AmountTooSmallForConfidentialPrecision();

    constructor(
        IERC20 erc20_,
        string memory symbolOverride_
    )
        Ownable(msg.sender)
        FHERC20(
            string.concat("FHERC20 Wrapped ", IERC20Metadata(address(erc20_)).name()),
            bytes(symbolOverride_).length == 0
                ? string.concat("e", IERC20Metadata(address(erc20_)).symbol())
                : symbolOverride_,
            IERC20Metadata(address(erc20_)).decimals() <= 6
                ? IERC20Metadata(address(erc20_)).decimals()
                : 6
        )
    {
        try IFHERC20(address(erc20_)).isFherc20() returns (bool isFherc20) {
            if (isFherc20) {
                revert FHERC20InvalidErc20(address(erc20_));
            }
        } catch {
            // Not an FHERC20, continue
        }
        _erc20 = erc20_;

        _symbol = bytes(symbolOverride_).length == 0
            ? string.concat("e", IERC20Metadata(address(erc20_)).symbol())
            : symbolOverride_;

        // Conversion rate between the underlying ERC20 denomination and the confidential
        // precision (capped at 6 decimals to fit safely within euint64).
        uint8 underlyingDecimals = IERC20Metadata(address(erc20_)).decimals();
        _conversionRate = underlyingDecimals > 6 ? 10 ** (underlyingDecimals - 6) : 1;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function updateSymbol(string memory updatedSymbol) public onlyOwner {
        _symbol = updatedSymbol;
        emit SymbolUpdated(updatedSymbol);
    }

    /**
     * @dev Returns the address of the erc20 ERC-20 token that is being shielded.
     */
    function erc20() public view returns (IERC20) {
        return _erc20;
    }

    function shield(address to, uint256 value) public {
        if (to == address(0)) to = msg.sender;

        // Truncate to a multiple of the conversion rate to avoid precision loss.
        uint256 alignedValue = value - (value % _conversionRate);
        if (alignedValue == 0) revert AmountTooSmallForConfidentialPrecision();

        uint64 confidentialAmount = SafeCast.toUint64(alignedValue / _conversionRate);

        _erc20.safeTransferFrom(msg.sender, address(this), alignedValue);
        _mint(to, confidentialAmount);
        emit ShieldedERC20(msg.sender, to, alignedValue);
    }

    function unshield(address to, uint64 value) public {
        if (to == address(0)) to = msg.sender;
        euint64 burned = _burn(msg.sender, value);
        FHE.allowPublic(burned);
        _createClaim(to, value, burned);
        emit UnshieldedERC20(msg.sender, to, value);
    }

    /**
     * @notice Claim a decrypted amount of the underlying ERC20
     * @param ctHash The ctHash of the burned amount
     */
    function claimUnshielded(bytes32 ctHash, uint64 decryptedAmount, bytes memory decryptionSignature) public {
        Claim memory claim = _handleClaim(ctHash, decryptedAmount, decryptionSignature);

        // Scale confidential units back up to the underlying ERC20 denomination.
        uint256 erc20Amount = uint256(claim.decryptedAmount) * _conversionRate;
        _erc20.safeTransfer(claim.to, erc20Amount);
        emit ClaimedUnshieldedERC20(msg.sender, claim.to, erc20Amount);
    }

    /**
     * @notice Claim multiple decrypted amounts of the underlying ERC20
     * @param ctHashes The ctHashes of the burned amounts
     * @param decryptedAmounts The decrypted amounts
     * @param decryptionSignatures The decryption signatures
     */
    function claimUnshieldedBatch(
        bytes32[] memory ctHashes,
        uint64[] memory decryptedAmounts,
        bytes[] memory decryptionSignatures
    ) public {
        if (ctHashes.length != decryptedAmounts.length || ctHashes.length != decryptionSignatures.length) {
            revert LengthMismatch();
        }

        Claim[] memory claims = _handleClaimBatch(ctHashes, decryptedAmounts, decryptionSignatures);

        for (uint256 i = 0; i < claims.length; i++) {
            uint256 erc20Amount = uint256(claims[i].decryptedAmount) * _conversionRate;
            _erc20.safeTransfer(claims[i].to, erc20Amount);
            emit ClaimedUnshieldedERC20(msg.sender, claims[i].to, erc20Amount);
        }
    }
}
