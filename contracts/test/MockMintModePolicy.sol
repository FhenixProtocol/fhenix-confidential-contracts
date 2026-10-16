// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IMintModePolicy, MintMode } from "../ERC20Confidential/ERC20ConfidentialLib.sol";

/// @notice Test policy that resolves every account to PRIVATE, so {ERC20ConfidentialLib.autoShield}
///         always attempts to shield.
contract MockMintModePolicy is IMintModePolicy {
    function mintModeFor(address) external pure returns (MintMode) {
        return MintMode.PRIVATE;
    }
}
