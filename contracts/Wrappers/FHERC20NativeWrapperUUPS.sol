// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { IWETH } from "../interfaces/IWETH.sol";
import { FHERC20NativeWrapperUpgradeable } from "../FHERC20/extensions/FHERC20NativeWrapperUpgradeable.sol";

/**
 * @dev Deployable UUPS host of {FHERC20NativeWrapperUpgradeable}: a confidential wrapper around the
 * chain's native token (e.g. ETH), meant to run behind an `ERC1967Proxy`.
 *
 * The owner is the only privileged account and authorizing upgrades is its only power. Ownership
 * moves in two steps: {transferOwnership} by the owner, then {acceptOwnership} by the new one. There is
 * no minter: supply moves through {shieldNative}, {shieldWrappedNative} and {unshield} alone.
 *
 * WARNING: an upgrade can move all the native value the wrapper holds, so the owner should be
 * a multisig.
 *
 * The implementation must be linked against {ERC20ConfidentialLib} (see {FHERC20NativeWrapperCore}).
 */
contract FHERC20NativeWrapperUUPS is FHERC20NativeWrapperUpgradeable, Ownable2StepUpgradeable, UUPSUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev One-time proxy initializer. `owner_` receives upgrade authority at once, with no
     * acceptance step.
     *
     * {decimals} is taken from `weth_` and capped at 6 (see {FHERC20NativeWrapperCore}).
     */
    function initialize(
        IWETH weth_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_,
        address owner_
    ) external initializer {
        // Wrapper first: decimals() then returns the capped wrapper decimals, which
        // __FHERC20_init needs to size the indicator tick.
        __FHERC20NativeWrapper_init(weth_);
        __FHERC20_init(name_, symbol_, decimals(), contractURI_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(address /* newImplementation */) internal override onlyOwner {}
}
