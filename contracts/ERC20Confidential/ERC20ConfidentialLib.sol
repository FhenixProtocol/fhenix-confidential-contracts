// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, euint64, externalEuint64, sharedEuint64, ebool } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";
import { FHERC20Utils } from "../FHERC20/utils/FHERC20Utils.sol";
import { ERC20ConfidentialIndicator } from "./ERC20ConfidentialIndicator.sol";

/// @dev Self-only bridge the host token exposes so this delegatecall'd library can
/// reach the host's ledger hooks (`_ledgerTransfer` / `_ledgerMint`) for the
/// shield / unshield-claim / mint orchestration relocated here.
interface IConfidentialLedger {
    /// @dev `from == address(0)` ⇒ ledger mint; otherwise ledger transfer.
    function __ledger(address from, address to, uint256 amount) external;

    /// @dev The host's standard public ERC-20 `balanceOf` (every host IS an ERC-20; no
    /// self-only bridge needed for a public view). Used to derive the confidential total
    /// supply from the pool's balance.
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Mint-mode resolved per account by an {IMintModePolicy}: whether freshly minted
/// public tokens should stay public or be auto-shielded into the confidential layer.
/// Tri-state so a policy's per-user mapping can distinguish "never set" (UNSET → fall
/// back to a default) from an explicit choice. UNSET is never a valid resolved mode.
enum MintMode {
    UNSET,
    PUBLIC,
    PRIVATE
}

/// @dev Policy consulted by {ERC20ConfidentialLib.autoShield} on every mint-and-shield
/// candidate (e.g. a wrap that mints public tokens). Hosts supply their own policy
/// implementation; this library only consumes the resolved mode.
interface IMintModePolicy {
    function mintModeFor(address account) external view returns (MintMode);
}

/**
 * @title  ERC20ConfidentialLib
 * @notice External (linked, delegatecall'd) home for the heaviest confidential balance logic, so
 *         that code lives in this library's own deployed bytecode instead of being embedded in
 *         every host token. Used by {ERC20ConfidentialCoreUpgradeable} to keep a token that fuses
 *         the confidential layer with a large public base under the EIP-170
 *         24 KB limit WITHOUT dropping any functionality.
 *
 * @dev    `public` library functions → the compiler emits `delegatecall`, so they run in the
 *         HOST's context: `address(this)` is the token and `msg.sender` is the original caller —
 *         exactly what the FHE ACL grants (`allowThis` / `allow(_, msg.sender)`) and the operator
 *         checks need. The storage struct is passed by reference (resolves to the host's ERC-7201
 *         slot) and is defined HERE so host and library share one type. Functions that need the
 *         host's public ledger (`shield`/`unshield`/mint) stay in the host; everything purely
 *         confidential lives here.
 */
library ERC20ConfidentialLib {
    /// @custom:storage-location erc7201:fherc20.storage.ERC20Confidential
    struct ERC20ConfidentialStorage {
        mapping(address => euint64) _confidentialBalances;
        mapping(address => mapping(address => uint48)) _operators;
        ERC20ConfidentialIndicator _indicatorToken;
        uint8 _decimals;
        uint8 _confidentialDecimals;
        uint256 _conversionRate;
        // Compliance observer (ERC-7984-style). When set, every confidential
        // balance handle produced by `update()` is also FHE.allow'd to it, so the
        // observer can decrypt going forward. Past handles are topped up via
        // `grantPast`. Append-only field — keep last for storage-layout safety.
        address _observer;
        // REGISTERED ciphertext mirroring the confidential total supply (pool balance / rate).
        // Refreshed by `syncConfidentialTotalSupply` on every pool-balance change; publicly
        // decryptable since the plaintext is derivable from public state. Zero handle until the
        // first refresh. Append-only fields only below this point.
        euint64 _confidentialTotalSupply;
    }

    // Pool that custodies the public ledger tokens backing confidential balances.
    // Mirrors the constant in ERC20ConfidentialCoreUpgradeable.
    address constant CONFIDENTIAL_POOL = address(0x1011000000000000000000000000000000000000);

    // Mirrors ERC20ConfidentialCoreUpgradeable's ERC-7201 slot (the namespace is fixed,
    // so it is identical for every host). Newer entry points ({autoShield},
    // {setObserver}, {grantObserverPast}) resolve the slot HERE instead of taking a
    // `storage $` parameter: their hosts sit at the EIP-170 ceiling, and dropping the
    // parameter removes a 32-byte slot push from every host call site.
    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.ERC20Confidential")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ERC20_CONFIDENTIAL_STORAGE_LOCATION =
        0xb440e9c559aceef9e2c75ec16e8d26ee97396e4a6978215085407b7ab0709e00;

    function _getERC20ConfidentialStorage() private pure returns (ERC20ConfidentialStorage storage $) {
        assembly {
            $.slot := ERC20_CONFIDENTIAL_STORAGE_LOCATION
        }
    }

    event ConfidentialTransfer(address indexed from, address indexed to, euint64 indexed amount);
    // Signatures (and indexed-ness) must match IERC20ConfidentialCore so the
    // host token's ABI/topics are unchanged when these are emitted via delegatecall.
    event TokensShielded(address indexed account, uint256 amount);
    event TokensUnshielded(address indexed account, euint64 indexed amount);
    event UnshieldedTokensClaimed(
        address indexed account,
        bytes32 indexed unshieldRequestId,
        euint64 indexed unshieldAmount,
        uint64 unshieldAmountCleartext
    );
    // Emitted (as the host, via delegatecall) by the observer entry points relocated
    // here from the hosts; signatures match the hosts' own declarations, so the
    // topics/selector are identical either way.
    event ObserverSet(address indexed observer);
    event ObserverPastGranted(address indexed observer, uint256 count);

    error ERC20ConfidentialUnauthorizedSpender(address holder, address spender);
    error ConfidentialInvalidSender(address sender);
    error ConfidentialInvalidReceiver(address receiver);
    error AmountTooSmallForConfidentialPrecision();
    /// @notice Thrown when {grantObserverPast} runs with no observer configured.
    error NoObserverSet();

    // =========================================================================
    //  Core encrypted balance update (also used by the host for shield/mint)
    // =========================================================================

    /// @dev Saturating decrease on `from`, increase on `to`, ACL grants, indicator mirror, and the
    /// {ConfidentialTransfer} log. Returns the actually-moved (clamped) amount.
    function update(address from, address to, euint64 amount) public returns (euint64 transferred) {
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        euint64 ptr;
        address obs = $._observer; // compliance observer (0 = none); forward-grant below

        if (from != address(0)) {
            euint64 fromBalance = $._confidentialBalances[from];
            // `trySpend` hands back the amount it actually debited, so the credit leg below reads
            // it straight off the debit instead of re-deriving it with a second `FHE.select`.
            (, ptr, transferred) = FHESafeMath.trySpend(fromBalance, amount);
            FHE.allowThis(ptr);
            FHE.allow(ptr, from);
            if (obs != address(0)) FHE.allow(ptr, obs);
            $._confidentialBalances[from] = ptr;
        } else {
            transferred = amount; // mint: nothing to debit, so the full amount lands
        }

        if (to != address(0)) {
            ptr = FHE.add($._confidentialBalances[to], transferred);
            FHE.allowThis(ptr);
            FHE.allow(ptr, to);
            if (obs != address(0)) FHE.allow(ptr, obs);
            $._confidentialBalances[to] = ptr;
        }

        if (from != address(0)) FHE.allow(transferred, from);
        if (to != address(0)) FHE.allow(transferred, to);
        FHE.allowThis(transferred);
        if (obs != address(0)) FHE.allow(transferred, obs);

        ERC20ConfidentialIndicator ind = $._indicatorToken;
        if (address(ind) != address(0)) ind.emitConfidentialTransfer(from, to);

        emit ConfidentialTransfer(from, to, transferred);
    }

    // =========================================================================
    //  Compliance observer — past-value top-up
    // =========================================================================

    /// @dev Grant `observer` FHE access to historical ciphertext handles the host
    /// already owns (`allowThis`'d) — past transfer amounts (from {ConfidentialTransfer}
    /// events) and/or current balance handles (from `confidentialBalanceOf`). Closes
    /// the forward-only gap of the observer hook in `update()`.
    ///
    /// Runs under delegatecall, so `FHE.allow` executes as the host token, which holds
    /// permanent ACL on every handle it created. NOTE: on real CoFHE, a ctHash the host
    /// never owned reverts the whole call — the off-chain indexer must supply only this
    /// token's handles.
    function grantPast(address observer, uint256[] calldata ctHashes) public {
        for (uint256 i = 0; i < ctHashes.length; i++) {
            FHE.allow(euint64.wrap(bytes32(ctHashes[i])), observer);
        }
    }

    /// @dev Body of the hosts' `setObserver` (the host keeps only its access-control
    ///      gate): a bare storage write plus the event.
    function setObserver(address observer) public {
        _getERC20ConfidentialStorage()._observer = observer;
        emit ObserverSet(observer);
    }

    /// @dev Body of the hosts' `grantObserverPast` (the host keeps only its
    ///      access-control gate): grant the configured observer FHE access to
    ///      historical handles the host owns.
    function grantObserverPast(uint256[] calldata ctHashes) public {
        address observer = _getERC20ConfidentialStorage()._observer;
        if (observer == address(0)) revert NoObserverSet();
        grantPast(observer, ctHashes);
        emit ObserverPastGranted(observer, ctHashes.length);
    }

    // =========================================================================
    //  Shield / unshield / mint orchestration (relocated from the host token to
    //  fit under EIP-170; ledger ops reach the host via the self-only bridge).
    // =========================================================================

    function shield(uint256 amount) public {
        shieldTo(msg.sender, amount);
    }

    /// @dev The shield primitive with an explicit recipient: moves `to`'s public tokens
    ///      into the pool and credits `to`'s confidential balance. Strict like {shield}
    ///      always was (dust-only amounts and uint64 overflow revert). `to`-addressed so
    ///      flows where `msg.sender` is NOT the account being shielded (e.g. a wrap,
    ///      where `msg.sender` is the SwapFacility) can use it via {autoShield}.
    ///
    ///      Reverts on `to == address(0)`: the ledger bridge reads a zero `from` as a MINT, so
    ///      `__ledger(address(0), POOL, x)` would create unbacked public supply in the pool,
    ///      and the matching confidential credit would land on no account.
    function shieldTo(address to, uint256 amount) public {
        if (to == address(0)) revert ConfidentialInvalidReceiver(address(0));
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        uint256 rate = $._conversionRate;
        uint256 amountToShield = amount - (amount % rate);
        if (amountToShield == 0) revert AmountTooSmallForConfidentialPrecision();

        uint64 amountConfidential = SafeCast.toUint64(amountToShield / rate);

        IConfidentialLedger(address(this)).__ledger(to, CONFIDENTIAL_POOL, amountToShield);
        update(address(0), to, FHE.asEuint64(amountConfidential));
        syncConfidentialTotalSupply();

        emit TokensShielded(to, amountToShield);
    }

    /// @dev Shield `amount` (public base units, e.g. just minted by a wrap) into `to`'s
    ///      confidential balance when the {IMintModePolicy} resolves PRIVATE for `to`.
    ///
    ///      Best-effort BY DESIGN — auto-shielding is sugar on top of the calling flow
    ///      (typically a wrap, on the money path) and must never change its success
    ///      envelope, so every non-shieldable case degrades to "leave the mint public"
    ///      instead of reverting:
    ///        - `mintModes == address(0)`: feature disabled at deployment;
    ///        - `to == address(0)`: no account to credit ({shieldTo} would revert);
    ///        - policy call reverts: fail-open to PUBLIC;
    ///        - sub-precision amount (`amount < rate`): nothing to shield — and as with
    ///          {shield}, the `amount % rate` remainder always stays public;
    ///        - amount exceeds the euint64 domain: the user can shield in parts.
    ///
    ///      The pre-checks guarantee the strict {shieldTo} cannot revert. No reentrancy
    ///      surface beyond {shield}'s own: the ledger leg is a self-call into the host's
    ///      `_transfer` and the FHE ops call the trusted task manager.
    function autoShield(address mintModes, address to, uint256 amount) public {
        if (mintModes == address(0) || to == address(0)) return;
        try IMintModePolicy(mintModes).mintModeFor(to) returns (MintMode mode) {
            if (mode != MintMode.PRIVATE) return;
        } catch {
            return;
        }

        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        uint256 rate = $._conversionRate;
        uint256 amountToShield = amount - (amount % rate);
        if (amountToShield == 0) return;
        if (amountToShield / rate > type(uint64).max) return;

        shieldTo(to, amount);
    }

    function unshield(euint64 amount) public returns (euint64 burned) {
        burned = update(msg.sender, address(0), amount);
        FHE.allowPublic(burned);
        createClaim(msg.sender, burned);
        emit TokensUnshielded(msg.sender, burned);
    }

    function unshieldChecked(sharedEuint64 sharedAmount) public returns (euint64) {
        return unshield(FHE.receiveEuint64Param(sharedAmount));
    }

    function claimUnshielded(bytes32 id, uint64 decryptedAmount, bytes calldata decryptionProof) public {
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        Claim memory claim = handleClaim(id, decryptedAmount, decryptionProof);

        uint256 amountPublic = uint256(claim.decryptedAmount) * $._conversionRate;
        IConfidentialLedger(address(this)).__ledger(CONFIDENTIAL_POOL, claim.to, amountPublic);
        syncConfidentialTotalSupply();

        emit UnshieldedTokensClaimed(claim.to, id, FHE.wrapEuint64(claim.ctHash), claim.decryptedAmount);
    }

    /// @dev Reverts on `to == address(0)`, like {FHERC20Core-_mint}: otherwise the pool gains
    /// public backing that no confidential balance owns and that can never be unshielded.
    function confidentialMint(address to, uint64 amount) public {
        if (to == address(0)) revert ConfidentialInvalidReceiver(address(0));
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        IConfidentialLedger(address(this)).__ledger(address(0), CONFIDENTIAL_POOL, uint256(amount) * $._conversionRate);
        update(address(0), to, FHE.asEuint64(amount));
        syncConfidentialTotalSupply();
    }

    /// @dev Materializes the confidential total supply (pool balance / conversion rate) as a
    /// REGISTERED ciphertext handle. Runs inside every pool-balance-changing operation (shield /
    /// claim / confidential mint — NOT unshield: the pool keeps custody until the claim settles,
    /// so the supply still counts pending claims, same as the pool balance itself). The plaintext
    /// is derived from public state, so a trivial encryption suffices — no FHE arithmetic.
    /// `allowPublic` is deliberate: the value was never secret (anyone can read the pool's public
    /// balance), and the global ACL grant covers EVERY account — decryption by any consumer, use
    /// in other contracts' FHE ops, and the host's own future access (so no `allowThis` needed:
    /// `isAllowed` = transient ∨ persisted ∨ global).
    function syncConfidentialTotalSupply() public {
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        euint64 supply = FHE.asEuint64(confidentialTotalSupplyPlaintext());
        FHE.allowPublic(supply);
        $._confidentialTotalSupply = supply;
    }

    /// @dev The confidential total supply as a plaintext — pool balance scaled to confidential
    /// decimals; the source of truth {syncConfidentialTotalSupply} encrypts. SATURATES at
    /// `type(uint64).max` rather than reverting on overflow: the value feeds `FHE.asEuint64`, and
    /// the stored supply is an informational `euint64` that cannot represent more than that anyway.
    /// Clamping (not `SafeCast`) is deliberate — `syncConfidentialTotalSupply` runs inside
    /// shield / claimUnshielded / confidentialMint, and `CONFIDENTIAL_POOL` is a plain address
    /// whose public balance ANYONE can inflate with a direct token transfer ("donation"). A hard
    /// downcast revert here would let such a donation brick those flows (and, since the claim leg
    /// syncs after draining the pool, permanently deadlock claims). See audit run-3 Finding 9. The
    /// host's `uint256` view twin stays exact/unclamped for consumers that need the true figure.
    function confidentialTotalSupplyPlaintext() internal view returns (uint64) {
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        uint256 supply = IConfidentialLedger(address(this)).balanceOf(CONFIDENTIAL_POOL) / $._conversionRate;
        return supply > type(uint64).max ? type(uint64).max : uint64(supply);
    }

    // =========================================================================
    //  Confidential transfer surface (full orchestration; host wrappers are 1-liners)
    // =========================================================================

    // Under delegatecall from the host, `address(this)` is the host token, so the share/receive
    // pair below binds to the host — not to this library's own address.

    function confTransfer(address to, sharedEuint64 sharedValue) public returns (sharedEuint64) {
        euint64 value = FHE.receiveEuint64Param(sharedValue);
        return FHE.shareEuint64(_move(msg.sender, to, value), msg.sender);
    }

    function confTransferIn(
        address to,
        externalEuint64 inValue,
        bytes memory inputProof
    ) public returns (sharedEuint64) {
        euint64 transferred = _move(msg.sender, to, FHE.asEuint64(inValue, inputProof));
        return FHE.shareEuint64(transferred, msg.sender);
    }

    function confTransferFrom(
        address from,
        address to,
        sharedEuint64 sharedValue
    ) public returns (sharedEuint64) {
        euint64 value = FHE.receiveEuint64Param(sharedValue);
        if (!_isOperator(from, msg.sender)) revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        return FHE.shareEuint64(_move(from, to, value), msg.sender);
    }

    function confTransferFromIn(
        address from,
        address to,
        externalEuint64 inValue,
        bytes memory inputProof
    ) public returns (sharedEuint64) {
        if (!_isOperator(from, msg.sender)) revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        euint64 transferred = _move(from, to, FHE.asEuint64(inValue, inputProof));
        return FHE.shareEuint64(transferred, msg.sender);
    }

    function confTransferAndCall(
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) public returns (sharedEuint64) {
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        return FHE.shareEuint64(_moveAndCall(msg.sender, to, amount, data), msg.sender);
    }

    function confTransferAndCallIn(
        address to,
        externalEuint64 inAmount,
        bytes memory inputProof,
        bytes calldata data
    ) public returns (sharedEuint64) {
        euint64 transferred = _moveAndCall(msg.sender, to, FHE.asEuint64(inAmount, inputProof), data);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    function confTransferFromAndCall(
        address from,
        address to,
        sharedEuint64 sharedAmount,
        bytes calldata data
    ) public returns (sharedEuint64) {
        euint64 amount = FHE.receiveEuint64Param(sharedAmount);
        if (!_isOperator(from, msg.sender)) revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        return FHE.shareEuint64(_moveAndCall(from, to, amount, data), msg.sender);
    }

    function confTransferFromAndCallIn(
        address from,
        address to,
        externalEuint64 inAmount,
        bytes memory inputProof,
        bytes calldata data
    ) public returns (sharedEuint64) {
        if (!_isOperator(from, msg.sender)) revert ERC20ConfidentialUnauthorizedSpender(from, msg.sender);
        euint64 transferred = _moveAndCall(from, to, FHE.asEuint64(inAmount, inputProof), data);
        return FHE.shareEuint64(transferred, msg.sender);
    }

    function isOperator(address holder, address spender) public view returns (bool) {
        return _isOperator(holder, spender);
    }

    // =========================================================================
    //  Internal helpers (inline within the library)
    // =========================================================================

    function _move(address from, address to, euint64 value) internal returns (euint64) {
        if (from == address(0)) revert ConfidentialInvalidSender(address(0));
        if (to == address(0)) revert ConfidentialInvalidReceiver(address(0));
        return update(from, to, value);
    }

    function _moveAndCall(
        address from,
        address to,
        euint64 amount,
        bytes calldata data
    ) internal returns (euint64 transferred) {
        euint64 sent = _move(from, to, amount);
        ebool success = FHERC20Utils.checkOnTransferReceived(msg.sender, from, to, sent, data);
        euint64 refund = update(to, from, FHE.select(success, FHE.asEuint64(0), sent));
        transferred = FHE.sub(sent, refund);
    }

    function _isOperator(address holder, address spender) internal view returns (bool) {
        ERC20ConfidentialStorage storage $ = _getERC20ConfidentialStorage();
        return holder == spender || block.timestamp <= $._operators[holder][spender];
    }

    // =========================================================================
    //  Unshield-claim bookkeeping (relocated from FHERC20WrapperClaimHelper).
    //  Uses its own ERC-7201 slot; the host delegates here so the (chunky)
    //  EnumerableSet code lives in the library, not in the token.
    // =========================================================================

    using EnumerableSet for EnumerableSet.Bytes32Set;

    struct Claim {
        bytes32 id; // unique per-claimant key (NOT the ciphertext handle); how the claim is referenced
        address to;
        bytes32 ctHash; // the burned ciphertext handle; binds the decryption proof in handleClaim
        uint64 decryptedAmount; // the PROVEN settle amount (set in handleClaim); the only trusted plaintext
        bool claimed;
    }

    /// @custom:storage-location erc7201:fherc20.storage.FHERC20WrapperClaimHelper
    struct ClaimStorage {
        mapping(bytes32 id => Claim) _claims; // keyed by claim id, NOT by the ciphertext handle
        mapping(address => EnumerableSet.Bytes32Set) _userClaims; // holds claim ids
        mapping(address => uint256) _claimNonce; // per-claimant counter for unique id derivation
    }

    // keccak256(abi.encode(uint256(keccak256("fherc20.storage.FHERC20WrapperClaimHelper")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CLAIM_SLOT = 0x90973842d0546f0dce9511f9a89cc80d5315812909eb805129843b5aeeaaae00;

    error ClaimNotFound();
    error AlreadyClaimed();

    function _claimStore() private pure returns (ClaimStorage storage $) {
        assembly {
            $.slot := CLAIM_SLOT
        }
    }

    /// @dev Records a pending unshield claim keyed by a UNIQUE per-claimant id, not by the
    /// ciphertext handle. CoFHE handles are content-addressed (a pure function of the operation
    /// lineage, with no per-caller or per-call salt), so two unshields of an identical
    /// burned-amount lineage produce the SAME handle; keying claims by that handle would let a
    /// second unshield overwrite the first claimant's record and redirect their payout. The
    /// handle is retained as `ctHash` to bind the decryption proof in {handleClaim}.
    function createClaim(address to, euint64 claimable) public returns (bytes32 id) {
        ClaimStorage storage $ = _claimStore();
        bytes32 h = FHE.unwrap(claimable);
        id = keccak256(abi.encode(to, $._claimNonce[to]++, h));
        $._claims[id] = Claim({ id: id, to: to, ctHash: h, decryptedAmount: 0, claimed: false });
        $._userClaims[to].add(id);
    }

    function handleClaim(
        bytes32 id,
        uint64 decryptedAmount,
        bytes memory decryptionProof
    ) public returns (Claim memory claim) {
        ClaimStorage storage $ = _claimStore();
        claim = $._claims[id];
        if (claim.to == address(0)) revert ClaimNotFound();
        if (claim.claimed) revert AlreadyClaimed();

        // The proof binds `decryptedAmount` to the burned handle (`ctHash`), which is fixed at
        // createClaim time — never to the caller-supplied `id`.
        FHE.verifyDecryptResult(FHE.wrapEuint64(claim.ctHash), decryptedAmount, decryptionProof);

        claim.decryptedAmount = decryptedAmount;
        claim.claimed = true;
        $._claims[id] = claim;
        $._userClaims[claim.to].remove(id);
    }

    function getClaim(bytes32 id) public view returns (Claim memory) {
        return _claimStore()._claims[id];
    }

    function getUserClaims(address user) public view returns (Claim[] memory userClaims) {
        ClaimStorage storage $ = _claimStore();
        bytes32[] memory ids = $._userClaims[user].values();
        userClaims = new Claim[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            userClaims[i] = $._claims[ids[i]];
        }
    }
}
