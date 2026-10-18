// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { ERC20ConfidentialCoreUpgradeable } from "../ERC20Confidential/ERC20ConfidentialCoreUpgradeable.sol";
import { ERC20ConfidentialLib } from "../ERC20Confidential/ERC20ConfidentialLib.sol";
import { euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/// @notice Minimal concrete confidential token for testing the relocated core +
///         library (shield/unshield/mint via the self-only `__ledger` bridge) and
///         the compliance observer, WITHOUT any heavy production base. A
///         trivial mapping stands in for the public ERC-20 ledger.
contract ConfidentialHarness is ERC20ConfidentialCoreUpgradeable {
    mapping(address => uint256) public ledger; // stand-in public ERC-20 ledger

    bool public paused;
    mapping(address => bool) public blocked;

    function initialize(uint8 confDecimals) external {
        // A 6-decimal public ledger scaled to `confDecimals` confidential precision.
        __ERC20ConfidentialCore_init(6, confDecimals);
    }

    // ── test seams ────────────────────────────────────────────────────────
    function ledgerMintPublic(address to, uint256 amount) external {
        ledger[to] += amount;
    }

    function mint(address to, uint64 amount) external {
        _confidentialMint(to, amount);
    }

    function shieldToPublic(address to, uint256 amount) external {
        ERC20ConfidentialLib.shieldTo(to, amount);
    }

    function autoShieldPublic(address mintModes, address to, uint256 amount) external {
        ERC20ConfidentialLib.autoShield(mintModes, to, amount);
    }

    function setObserverPublic(address obs) external {
        _setObserver(obs);
    }

    function grantPastPublic(address obs, uint256[] calldata ctHashes) external {
        ERC20ConfidentialLib.grantPast(obs, ctHashes);
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setBlocked(address a, bool v) external {
        blocked[a] = v;
    }

    /// @dev Surfaces the core's public decimals and the public<->confidential conversion rate,
    ///      which the core keeps internal (`_publicDecimals`/`_rate`), so tests can pin the
    ///      `rate == 10 ** (publicDecimals - confidentialDecimals)` invariant.
    function decimals() external view returns (uint8) {
        return _publicDecimals();
    }

    function rate() external view returns (uint256) {
        return _rate();
    }

    // A representative freeze/pause policy, so the hook wiring is exercised.
    function _beforeConfidentialMove(address from, address to) internal view override {
        require(!paused, "paused");
        require(!blocked[from] && !blocked[to], "frozen");
    }

    // ── ledger hooks (stand-in public ERC-20) ───────────────────────────────
    function _ledgerMint(address to, uint256 amount) internal override {
        ledger[to] += amount;
    }

    function _ledgerTransfer(address from, address to, uint256 amount) internal override {
        require(ledger[from] >= amount, "ledger: insufficient");
        ledger[from] -= amount;
        ledger[to] += amount;
    }

    function _ledgerBalanceOf(address account) internal view override returns (uint256) {
        return ledger[account];
    }

    /// @dev The library derives the confidential total supply through the host's standard
    /// public ERC-20 `balanceOf` (see {IConfidentialLedger}). Real hosts are ERC-20s and
    /// have it already; this stand-in ledger must expose it explicitly.
    function balanceOf(address account) public view returns (uint256) {
        return ledger[account];
    }
}
