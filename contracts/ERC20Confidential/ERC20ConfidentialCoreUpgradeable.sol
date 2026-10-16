// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, externalEuint64, sharedEuint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { IERC20ConfidentialCore } from "../interfaces/IERC20ConfidentialCore.sol";
import { IERC7984 } from "../interfaces/IERC7984.sol";
import { ERC20ConfidentialIndicator } from "./ERC20ConfidentialIndicator.sol";
import { ERC20ConfidentialLib } from "./ERC20ConfidentialLib.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

/**
 * @title ERC20ConfidentialCoreUpgradeable
 * @notice Ledger-agnostic, OZ-base-free variant of {ERC20ConfidentialUpgradeable}. It carries the
 * FULL confidential (FHE) layer — shield/unshield, confidential transfers, operators,
 * `_confidentialUpdate` — but inherits NO public ERC-20 implementation and NO OpenZeppelin base
 * contracts (`ERC20Upgradeable`, `ERC165Upgradeable`, `Initializable`). It reaches the host's
 * public ledger through three hooks ({_ledgerMint}, {_ledgerTransfer}, {_ledgerBalanceOf}).
 *
 * Why no OZ bases: this core is meant to be mixed into a contract that ALREADY brings its own
 * ledger + OZ stack, possibly vendoring its own copy of OpenZeppelin. Inheriting OZ here would
 * put a SECOND `Initializable` / `IERC165`
 * into the combined inheritance graph and fail to compile ("Identifier already declared"). So:
 *   - The confidential-only {IERC20ConfidentialCore} interface does not extend OZ `IERC20`/`IERC165`.
 *   - The claim facade {FHERC20WrapperClaims} drops OZ `Initializable`.
 *   - Init is plain `internal`; the HOST's initializer (its own `Initializable`) guards one-time setup.
 *
 * This is a NEW contract; {ERC20ConfidentialUpgradeable} is left untouched. State lives in the SAME
 * ERC-7201 slot (`fherc20.storage.ERC20Confidential`) so the confidential layout is portable.
 */
abstract contract ERC20ConfidentialCoreUpgradeable is IERC20ConfidentialCore, ReentrancyGuardTransient {
    /// @dev Single source of truth is the library constant; re-exposed here as a public getter.
    address public constant CONFIDENTIAL_POOL = ERC20ConfidentialLib.CONFIDENTIAL_POOL;

    // The confidential storage struct lives in ERC20ConfidentialLib so the library and this
    // contract share one type (the library mutates it via delegatecall). Same ERC-7201 slot.
    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.ERC20Confidential")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC20ConfidentialStorageLocation =
        0xb440e9c559aceef9e2c75ec16e8d26ee97396e4a6978215085407b7ab0709e00;

    function _getERC20ConfidentialStorage()
        private
        pure
        returns (ERC20ConfidentialLib.ERC20ConfidentialStorage storage $)
    {
        assembly {
            $.slot := ERC20ConfidentialStorageLocation
        }
    }

    error ERC20ConfidentialUnauthorizedUseOfEncryptedAmount(euint64 value, address user);
    error ERC20ConfidentialUnauthorizedSpender(address holder, address spender);
    error AmountTooSmallForConfidentialPrecision();
    error ConfidentialInvalidSender(address sender);
    error ConfidentialInvalidReceiver(address receiver);
    error ConfidentialReceiverMovedBalance(address receiver);
    error NotSelf();
    error ClaimBatchLengthMismatch();
    error InvalidDecryptionProof();

    // =========================================================================
    //  Ledger hooks — implemented by the host (its public ERC-20 ledger)
    // =========================================================================

    /// @dev Mint `amount` of the PUBLIC token to `to`. Host forwards to its ledger's `_mint`.
    function _ledgerMint(address to, uint256 amount) internal virtual;

    /// @dev Move `amount` of the PUBLIC token from `from` to `to`. Host forwards to `_transfer`.
    function _ledgerTransfer(address from, address to, uint256 amount) internal virtual;

    /// @dev Public token balance of `account`. Host forwards to its ledger's `balanceOf`.
    /// NOTE: the host must ALSO expose the standard public ERC-20 `balanceOf(address)` over the
    /// same ledger (every real host is an ERC-20) — the delegatecall'd library reads the pool's
    /// balance through it to refresh {confidentialTotalSupply} (see `IConfidentialLedger`).
    function _ledgerBalanceOf(address account) internal view virtual returns (uint256);

    // =========================================================================
    //  Initializer (no ERC-20 init, no Initializable — host guards the call).
    //  `name`/`symbol` are passed in (not read via name()/symbol()) so the
    //  confidential layer never owns the public-ledger metadata — that stays
    //  entirely with the host ERC-20, avoiding an external-vs-public override clash.
    // =========================================================================

    /// @param publicDecimals_       Decimals of the host's PUBLIC ERC-20 ledger.
    /// @param confidentialDecimals_ Desired decimals of the confidential layer; clamped to
    ///        `publicDecimals_` since the confidential side can be no finer than the public ledger
    ///        backing it. The conversion rate is then `10 ** (publicDecimals_ - confidentialDecimals)`,
    ///        so one confidential unit is backed by exactly that many public base units.
    function __ERC20ConfidentialCore_init(uint8 publicDecimals_, uint8 confidentialDecimals_) internal {
        ERC20ConfidentialLib.ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        uint8 confDecimals = confidentialDecimals_ <= publicDecimals_ ? confidentialDecimals_ : publicDecimals_;
        $._decimals = publicDecimals_;
        $._confidentialDecimals = confDecimals;
        $._conversionRate = 10 ** (publicDecimals_ - confDecimals);
    }

    /// @dev Wire an externally-deployed indicator token. Kept out of the initializer (and not
    /// `new`-ed here) so the indicator's ~2.4 KB of creation code is NOT embedded into the host's
    /// bytecode, which matters for size-constrained hosts. Optional: confidential transfers
    /// work without an indicator; if set, they emit indicator mirror events.
    function _setIndicatorToken(ERC20ConfidentialIndicator token) internal {
        _getERC20ConfidentialStorage()._indicatorToken = token;
    }

    function confidentialDecimals() public view virtual returns (uint8) {
        return _getERC20ConfidentialStorage()._confidentialDecimals;
    }

    /// @dev Decimals of the host's PUBLIC ledger as recorded at init (`$._decimals`). For hosts
    /// whose `decimals()` must read the value the monolithic implementation stored in the shared
    /// ERC-7201 struct (so it survives proxy upgrades from that implementation).
    function _publicDecimals() internal view returns (uint8) {
        return _getERC20ConfidentialStorage()._decimals;
    }

    function contractURI() public view virtual returns (string memory) {
        return "";
    }

    function indicatorToken() public view virtual returns (ERC20ConfidentialIndicator) {
        return _getERC20ConfidentialStorage()._indicatorToken;
    }

    /// @notice The compliance observer that gains FHE access to confidential values
    ///         (address(0) = none). Set via a host's role-gated entry point.
    function observer() public view virtual returns (address) {
        return _getERC20ConfidentialStorage()._observer;
    }

    /// @dev Set the compliance observer. Forward access is granted in `update()`;
    /// past handles are topped up via `ERC20ConfidentialLib.grantPast`. Hosts wrap
    /// this behind access control.
    function _setObserver(address observer_) internal {
        _getERC20ConfidentialStorage()._observer = observer_;
    }

    /// @dev `false` because {balanceOf} returns the real public ERC-20 balance, not an indicator.
    function balanceOfIsIndicator() public pure virtual returns (bool) {
        return false;
    }

    /// @dev Always `0`: {balanceOf} is not an indicator on this token.
    function indicatorTick() public pure virtual returns (uint256) {
        return 0;
    }

    /// @dev A REGISTERED, publicly-decryptable ciphertext mirroring {CONFIDENTIAL_POOL}'s public
    /// balance scaled to confidential decimals. Refreshed on every pool-balance change (shield /
    /// claim / confidential mint) and permissionlessly via {syncConfidentialTotalSupply}. Zero
    /// handle until the first refresh (fresh deployments before any shield, or proxies upgraded
    /// from an implementation that pre-dates the stored handle — sync once after upgrading).
    function confidentialTotalSupply() public view virtual returns (euint64) {
        return _getERC20ConfidentialStorage()._confidentialTotalSupply;
    }

    /// @dev Plaintext twin of {confidentialTotalSupply}. The value is public information (the
    /// pool's public balance scaled to confidential decimals), so it is exposed directly for
    /// consumers that don't need a ciphertext. Derived on read — always current, even when the
    /// stored handle is stale (pool donations) or not yet initialized (pre-first-sync).
    function confidentialTotalSupplyPlaintext() public view virtual returns (uint256) {
        return _ledgerBalanceOf(CONFIDENTIAL_POOL) / _rate();
    }

    function confidentialBalanceOf(address account) public view virtual returns (euint64) {
        return _getERC20ConfidentialStorage()._confidentialBalances[account];
    }

    function isOperator(address holder, address spender) public view virtual returns (bool) {
        return ERC20ConfidentialLib.isOperator(holder, spender);
    }

    /// @dev The confidential interface ids the host's `supportsInterface` should OR in.
    ///
    /// Covers ERC-7984 as well as the confidential-only core
    function _confidentialSupportsInterface(bytes4 interfaceId) internal pure returns (bool) {
        return interfaceId == type(IERC20ConfidentialCore).interfaceId || interfaceId == type(IERC7984).interfaceId;
    }

    // =========================================================================
    //  Shield / Unshield
    // =========================================================================

    // Thin wrappers — orchestration relocated to ERC20ConfidentialLib (EIP-170).
    // Ledger ops reach back through the self-only `__ledger` bridge below. The guard
    // hook stays here so the host's override is invoked.

    // `nonReentrant` even though shield's only external call is the self-call to `__ledger`
    // (→ the host's public `_transfer`), which does not hand control to untrusted code and moves
    // no confidential balance a callback could race.
    function shield(uint256 amount) public virtual nonReentrant {
        ERC20ConfidentialLib.shield(amount);
    }

    function unshield(uint64 amount) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(msg.sender, address(0));
        return FHE.shareEuint64(ERC20ConfidentialLib.unshield(FHE.asEuint64(amount)), msg.sender);
    }

    function unshield(sharedEuint64 sharedAmount) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(msg.sender, address(0));
        return FHE.shareEuint64(ERC20ConfidentialLib.unshieldChecked(sharedAmount), msg.sender);
    }

    // `nonReentrant` even though the only external call is the self-call to `__ledger`
    // (→ the host's public `_transfer`), which hands control to no untrusted code, and replay is
    // already prevented by the claim's `claimed` flag in `handleClaim`. Both of those remain true;
    // the guard is here so the safety of this path stops depending on them.
    //
    // Overriders must NOT re-apply `nonReentrant` — an override that extends this via `super`
    // with a guard on both sides of that dispatch would deadlock.
    //
    // `id` is the unique claim id from {getClaim}/{getUserClaims} (NOT the ciphertext handle).
    function claimUnshielded(
        bytes32 id,
        uint64 decryptedAmount,
        bytes calldata decryptionProof
    ) public virtual nonReentrant {
        ERC20ConfidentialLib.claimUnshielded(id, decryptedAmount, decryptionProof);
    }

    // `nonReentrant` for the same reason as {claimUnshielded}, and with the same constraint on
    // overriders. Each `ids[i]` is the unique claim id from {getClaim}/{getUserClaims} (NOT the
    // ciphertext handle).
    function claimUnshieldedBatch(
        bytes32[] calldata ids,
        uint64[] calldata decryptedAmounts,
        bytes[] calldata decryptionProofs
    ) public virtual nonReentrant {
        if (ids.length != decryptedAmounts.length || ids.length != decryptionProofs.length) {
            revert ClaimBatchLengthMismatch();
        }
        for (uint256 i = 0; i < ids.length; i++) {
            ERC20ConfidentialLib.claimUnshielded(ids[i], decryptedAmounts[i], decryptionProofs[i]);
        }
    }

    /// @notice Re-derive the {confidentialTotalSupply} handle from the pool's current public
    /// balance. The library refreshes it inside every shield / claim / confidential mint, so this
    /// is only needed ONCE after upgrading a proxy from an implementation that pre-dates the
    /// stored handle, and to heal drift from direct public transfers ("donations") to
    /// {CONFIDENTIAL_POOL}, which bypass those refresh points. Permissionless — the value is
    /// public information.
    function syncConfidentialTotalSupply() public virtual {
        ERC20ConfidentialLib.syncConfidentialTotalSupply();
    }

    /// @dev Self-only ledger bridges: the delegatecall'd library calls these on the
    /// host (an external self-call), which forwards to the host's ledger hooks.
    function __ledger(address from, address to, uint256 amount) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (from == address(0)) _ledgerMint(to, amount);
        else _ledgerTransfer(from, to, amount);
    }

    /// @notice Pending-claim views (delegated to the library, which owns the claim storage).
    /// @dev Keyed by the unique claim id (the `id` field of {ERC20ConfidentialLib.Claim}),
    /// not by the ciphertext handle.
    function getClaim(bytes32 id) public view virtual returns (ERC20ConfidentialLib.Claim memory) {
        return ERC20ConfidentialLib.getClaim(id);
    }

    function getUserClaims(address user) public view virtual returns (ERC20ConfidentialLib.Claim[] memory) {
        return ERC20ConfidentialLib.getUserClaims(user);
    }

    // =========================================================================
    //  Confidential Transfers
    // =========================================================================

    // Thin wrappers — the full orchestration lives in ERC20ConfidentialLib (delegatecall'd) so its
    // code isn't embedded in the host token. msg.sender/this are preserved under delegatecall.

    /// @dev Hook invoked before every confidential balance move: the transfer overloads,
    /// `unshield`, and the issuer `_confidentialMint`. Default no-op; hosts override to enforce
    /// policy (e.g. freeze/pause).
    ///
    /// `shield` and `claimUnshielded` are the two paths that do NOT call this, and deliberately so:
    /// both reach the host's public ledger via `_ledgerTransfer`, so a host's public transfer hook
    /// already gates them. `_confidentialMint` used to be exempt on the same reasoning, but its
    /// ledger leg is `_ledgerMint`, and a public-ledger base is not obliged to offer a mint hook,
    /// so on a freeze- or pause-bearing host whose base has none, nothing gated it. It now calls
    /// this hook directly (Diligence 5.33).
    function _beforeConfidentialMove(address from, address to) internal virtual {}

    function confidentialTransfer(
        address to,
        sharedEuint64 sharedValue
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(msg.sender, to);
        return ERC20ConfidentialLib.confTransfer(to, sharedValue);
    }

    function confidentialTransfer(
        address to,
        externalEuint64 inValue,
        bytes calldata inputProof
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(msg.sender, to);
        return ERC20ConfidentialLib.confTransferIn(to, inValue, inputProof);
    }

    function confidentialTransferFrom(
        address from,
        address to,
        sharedEuint64 sharedValue
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(from, to);
        return ERC20ConfidentialLib.confTransferFrom(from, to, sharedValue);
    }

    function confidentialTransferFrom(
        address from,
        address to,
        externalEuint64 inValue,
        bytes calldata inputProof
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(from, to);
        return ERC20ConfidentialLib.confTransferFromIn(from, to, inValue, inputProof);
    }

    function confidentialTransferAndCall(
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(msg.sender, to);
        return ERC20ConfidentialLib.confTransferAndCall(to, sharedAmount, data);
    }

    function confidentialTransferAndCall(
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(msg.sender, to);
        return ERC20ConfidentialLib.confTransferAndCallIn(to, encryptedAmount, inputProof, data);
    }

    function confidentialTransferFromAndCall(
        address from,
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(from, to);
        return ERC20ConfidentialLib.confTransferFromAndCall(from, to, sharedAmount, data);
    }

    function confidentialTransferFromAndCall(
        address from,
        address to,
        externalEuint64 encryptedAmount,
        bytes calldata inputProof,
        bytes calldata data
    ) public virtual nonReentrant returns (sharedEuint64) {
        _beforeConfidentialMove(from, to);
        return ERC20ConfidentialLib.confTransferFromAndCallIn(from, to, encryptedAmount, inputProof, data);
    }

    // =========================================================================
    //  Operators
    // =========================================================================

    function setOperator(address operator, uint48 until) public virtual {
        _setOperator(msg.sender, operator, until);
    }

    // =========================================================================
    //  Confidential Mint (for inheriting contracts)
    // =========================================================================

    /// @dev Issuer mint of confidential balance, for inheriting contracts.
    ///
    /// `from` is `address(0)`: there is no payer, and a zero `from` is already a documented no-op
    /// for a host's freeze check, so the hook resolves to the pause check plus a freeze check on
    /// the recipient — nothing a mint should be exempt from.
    function _confidentialMint(address to, uint64 amount) internal virtual {
        _beforeConfidentialMove(address(0), to);
        ERC20ConfidentialLib.confidentialMint(to, amount);
    }

    // =========================================================================
    //  Internal helpers
    // =========================================================================

    /// @dev Thin wrapper: the heavy encrypted-balance logic lives in {ERC20ConfidentialLib.update}
    /// (a linked library, delegatecall'd) so it isn't embedded in the host token's bytecode.
    function _confidentialUpdate(
        address from,
        address to,
        euint64 amount
    ) internal virtual returns (euint64 transferred) {
        return ERC20ConfidentialLib.update(from, to, amount);
    }

    function _setOperator(address holder, address operator, uint48 until) internal virtual {
        _getERC20ConfidentialStorage()._operators[holder][operator] = until;
        emit OperatorSet(holder, operator, until);
    }

    function _rate() internal view virtual returns (uint256) {
        return _getERC20ConfidentialStorage()._conversionRate;
    }
}
