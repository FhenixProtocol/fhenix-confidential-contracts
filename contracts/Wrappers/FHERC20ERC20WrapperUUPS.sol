// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { IERC20 } from "@openzeppelin/contracts/interfaces/IERC20.sol";
import { Ownable2StepUpgradeable } from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import { UUPSUpgradeable } from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import { FHERC20ERC20WrapperUpgradeable } from "../FHERC20/extensions/FHERC20ERC20WrapperUpgradeable.sol";

/**
 * @dev Deployable UUPS host of {FHERC20ERC20WrapperUpgradeable}: a confidential wrapper around one
 * `ERC20` token, meant to run behind an `ERC1967Proxy`.
 *
 * The owner is the only privileged account and authorizing upgrades is its only power. Ownership
 * moves in two steps: {transferOwnership} by the owner, then {acceptOwnership} by the new one. There is
 * no minter: supply moves through {shield} and {unshield} alone.
 *
 * WARNING: an upgrade can move every underlying token the wrapper holds, so the owner should be
 * a multisig.
 *
 * The implementation must be linked against {ERC20ConfidentialLib} (see {FHERC20ERC20WrapperCore}).
 */
contract FHERC20ERC20WrapperUUPS is FHERC20ERC20WrapperUpgradeable, Ownable2StepUpgradeable, UUPSUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @dev One-time proxy initializer. `owner_` receives upgrade authority at once, with no
     * acceptance step.
     *
     * {decimals} is taken from `underlying_` and capped at 6 (see {FHERC20ERC20WrapperCore}).
     */
    function initialize(
        IERC20 underlying_,
        string memory name_,
        string memory symbol_,
        string memory contractURI_,
        address owner_
    ) external initializer {
        // Wrapper first: decimals() then returns the capped wrapper decimals, which
        // __FHERC20_init needs to size the indicator tick.
        __FHERC20ERC20Wrapper_init(underlying_);
        __FHERC20_init(name_, symbol_, decimals(), contractURI_);
        __Ownable_init(owner_);
        __Ownable2Step_init();
    }

    /// @inheritdoc UUPSUpgradeable
    function _authorizeUpgrade(address /* newImplementation */) internal override onlyOwner {}
}
