# Changelog

## 1.0.0

### Major Changes

- cc29d7d: 1.0.0: the Consensys Diligence audited release.

  The library contracts now match the revision reviewed by Consensys Diligence, with the fixes for every finding that applies to this package (5.13, 5.16, 5.18, 5.28, 5.30, 5.31, 5.32, 5.33; 5.15 acknowledged). See `docs/audits/README.md`.

  **Redeploy `ERC20ConfidentialLib`.** Its ABI and bytecode changed (new errors, `reassignClaim`). 1.0.0 hosts must link against a library deployed from 1.0.0; instances deployed from 0.x are not the audited code.

  New:

  - `FHERC20ERC20WrapperUUPS` and `FHERC20NativeWrapperUUPS` (`contracts/Wrappers/`): deployable wrapper hosts for an `ERC1967Proxy`, with `Ownable2Step` ownership whose only power is authorizing upgrades. **These two hosts are not audited.**
  - `reassignClaim(id, newTo)` on both wrappers, and `claimUnshieldedAsWETH` on the native wrapper (event `ClaimedUnshieldedAsWETH`). Both are callable only by the claim recipient or their operator, and give a recipient that cannot accept the payout a way to recover it (5.13). Custom contracts built directly on `FHERC20WrapperClaims` must implement its new abstract `_isClaimOperator`; both wrapper cores already do.
  - `ERC20ConfidentialCoreUpgradeable` advertises `type(IERC7984).interfaceId` through ERC-165 (5.28).
  - `balanceOfIsIndicator()` / `indicatorTick()` on `ERC20ConfidentialIndicator`, matching `FHERC20` (5.18).

  Behavior changes:

  - `nonReentrant` on every shield, claim and `onTransferReceived` path of both wrappers and the confidential core (5.31). An override that extends `claimUnshielded` / `claimUnshieldedBatch` through `super` must not add its own guard, or the call deadlocks.
  - A rejected decryption proof now reverts with the token's own `InvalidDecryptionProof()` instead of the TaskManager's `InvalidSignature()` / `InvalidSigner(...)` (5.32).
  - A receiver whose balance moves during `onConfidentialTransferReceived` makes the transfer revert with `FHERC20ReceiverMovedBalance` / `ConfidentialReceiverMovedBalance` (5.16).
  - `_confidentialMint` now runs `_beforeConfidentialMove(address(0), to)`, so host pause/freeze policy gates issuer mints (5.33). Freeze checks must treat `from == address(0)` as a no-op.
  - `ERC20ConfidentialIndicator.balanceOf` returns 0 for accounts with no confidential activity instead of a nonzero floor, and `totalSupply()` tracks the indicated sum (5.18). Wallets hide the token for those accounts until first use.

  Removed:

  - `FHESafeMath.trySpend` (added in 0.4.0). It was not part of the audited revision, so the debit path is back on `tryDecrease` plus one `FHE.select`, at roughly 121k more gas per confidential transfer against the mocks. `tryDecrease`, `tryIncrease`, `tryAdd` and `trySub` are unchanged.

  Dependencies: `@fhenixprotocol/cofhe-contracts` 1.0.0 (stable; replaces the 0.2.0 pin) and `@cofhe/*` 0.8.0.

## 0.4.0

### Minor Changes

- 3ecb00c: Move the remaining confidential boundary values onto the `sharedEuintXX` types, and pair `inputProof` with the handles it authenticates.

  **Breaking, and invisible to the compiler.** `euint64`, `externalEuint64` and `sharedEuint64` are all `bytes32` on the wire, so every selector below is unchanged. Existing callers keep compiling and fail at runtime with `NotShared`.

  - The `bytes32` overloads of `confidentialTransfer`, `confidentialTransferFrom`, `confidentialTransferAndCall`, `confidentialTransferFromAndCall` and `unshield` now take `sharedEuint64`. Callers must produce the value with `FHE.shareEuint64(handle, token)`; the `isAllowed` guard is replaced by the share check, which establishes provenance rather than possession. These entry points are consequently reachable only from a contract — an EOA cannot create a share, and should use the `externalEuint64 + inputProof` overload, which is unchanged.
  - Those functions, plus `shield`, `shieldNative`, `shieldWrappedNative` and both `unshield` overloads, now return `sharedEuint64` instead of a bare handle with an `allowTransient` grant. Contract callers must consume the result with `FHE.receiveEuint64FromCall(returned, token)`, naming the address called in the same expression.
  - On the four `*AndCall` overloads `inputProof` now precedes `bytes data`, immediately after the handle it authenticates. This is the ordering `@cofhe/abi` 0.7.0 requires: it locates the batch signature in the plain `bytes` following the contiguous run of `external*` inputs. Against the older pre-0.7 helper, which required that `bytes` in the _final_ slot, the two `bytes` arguments swap meaning silently — neither version throws on the wrong ordering, because the wrong parameter is also `bytes`. Callers must be on `@cofhe/*` 0.7.0.

  `ERC20ConfidentialUnauthorizedUseOfEncryptedAmount` is removed from both `ERC20ConfidentialLib` and `ERC20ConfidentialCoreUpgradeable`: no code path throws it once the share check replaces the `isAllowed` guards. `FHERC20UnauthorizedUseOfEncryptedAmount` stays — `requestDiscloseEncryptedAmount` still throws it, and keeps its `isAllowed` guard because there is no share to consume there.

- 0e57fb6: Add `FHESafeMath.trySpend` and route the confidential debit path through it, cutting one FHE operation from every transfer.

  The debit leg used to run two selects for one decision: `tryDecrease` selected between the old and new balance, then the call site re-derived the moved amount with a second `FHE.select(success, amount, 0)`. `trySpend` returns the debited amount alongside the updated balance, so the caller reads it off the debit instead of recomputing it — and selecting the delta first lets a single `FHE.sub` replace `tryDecrease`'s `FHE.sub` + `FHE.select` pair:

  ```solidity
  success = FHE.gte(balance, amount);
  spent   = FHE.select(success, amount, FHE.asEuint64(0));
  updated = FHE.sub(balance, spent); // `spent` fits by construction, so this cannot underflow
  ```

  Six FHE tasks per transfer become five (`gte`, `trivialEncrypt`, `select`, `sub`, `add`), which measures as ~121k gas saved per confidential transfer against the mock coprocessor (`ERC20Confidential` 986,873 → 865,224; base `FHERC20` 976,880 → 855,409, both ~12%). `confidentialTransferAndCall` runs two debits and saves twice.

  Semantics are unchanged: the debit is still all-or-nothing, so an over-balance transfer moves nothing rather than partially draining the sender, and `spent` is always an initialized, caller-owned handle that is safe to `FHE.allow`.

  `tryDecrease`, `tryIncrease`, `tryAdd`, and `trySub` are untouched, so nothing downstream breaks — `trySpend` is purely additive. `tryDecrease` now has no in-repo call sites and remains only as published API.

- 8f93eb7: Migrate to `@cofhe/*` 0.7 and `@fhenixprotocol/cofhe-contracts` 0.2.x (batch input verification).

  `cofhe-contracts` 0.2.x deletes the `InEuintXX` structs and the `FHE.asEuint64(InEuint64)` overload. The per-ciphertext signature that the struct used to carry is replaced by one signature per batch, passed as a trailing `bytes` parameter.

  Breaking changes:

  - **Every function taking an encrypted input changed shape.** `InEuint64 memory encryptedAmount` becomes `externalEuint64 encryptedAmount, bytes calldata inputProof`, across `IERC7984`, `IERC20ConfidentialCore`, `FHERC20Core`, `ERC20ConfidentialCoreUpgradeable` and `ERC20ConfidentialLib`. On the wire the struct tuple `(uint256,uint8,uint8,bytes)` becomes `bytes32,bytes`, so callers selecting overloads by signature string must be updated.
  - **The `*AndCall` overloads gained a second `bytes` parameter**: `confidentialTransferAndCall(address,bytes32,bytes,bytes)`. `inputProof` sits immediately after the handle it authenticates, ahead of `bytes data` — `@cofhe/abi` locates the batch signature in the plain `bytes` following the contiguous run of `external*` inputs (cofhesdk changeset `proof-follows-hash`). Callers selecting this overload by signature string get an unchanged selector, so the two `bytes` arguments must be ordered by hand.
  - **`ERC20ConfidentialLib` must be redeployed and every host relinked.** Its ABI changed, so this build is not interchangeable with library instances deployed before 0.7.
  - **Callers must name the consuming contract before encrypting.** `client.encryptInputs([...])` now requires `.setConsumingContract(address)` before `.execute()`, and `execute()` returns `[...hashes, signature]` rather than one struct per value. The verifier binds the consuming contract into the signed digest, so a batch signed for one contract cannot be replayed into another.
  - **The `@cofhe/*` packages are on `0.7.0`.** `@fhenixprotocol/cofhe-contracts` stays pinned to `0.2.0-beta.3`: the 0.2.x line is what carries `externalEuint64` / `sharedEuint64`, and it has no stable release yet (`latest` is still 0.1.5). Confirm that pin before publishing this package.

  The move onto the `sharedEuintXX` types for encrypted values crossing a contract boundary is tracked separately, in its own changeset in this release.

- 8a69d1b: Move the transfer-callback boundary onto the `sharedEuintXX` types.

  `IERC7984Receiver.onConfidentialTransferReceived` previously took a bare `euint64` and returned a bare `ebool`, with permission granted out of band via `FHE.allowTransient`. On a callback that cannot authenticate its caller, that is a decryption oracle: FHE operations check the permission of the _contract_ performing them, so any caller could pass any handle the receiver is allowed on (including the receiver's own stored state) and read back a value derived from it.

  Breaking change:

  - **`IERC7984Receiver.onConfidentialTransferReceived` now takes `sharedEuint64` and returns `sharedEbool`.** Both are `bytes32` on the wire, so existing receivers keep compiling against the old signature and fail at runtime with `NotShared`. Every receiver must migrate in the same change.

  Implementers must unwrap the amount with `FHE.receiveEuint64Param(amount)`, which requires the sharer to be `msg.sender`, and return `FHE.shareEbool(result, msg.sender)` instead of granting the token access with `FHE.allowTransient`. A received handle carries transient access only; persisting it past the transaction requires `FHE.allowThis` on the unwrapped `euint64`.

  `FHERC20Utils.checkOnTransferReceived` still returns a plain `ebool`, so callers inside the token are unaffected.

  This scoped out the ERC-7984 user-facing entry points, which kept accepting bare handles guarded by `FHE.isAllowed(value, msg.sender)`. That is superseded within this same release — see the changeset that moves the remaining boundary values onto `sharedEuintXX`. Wallet callers use the `externalEuint64 + inputProof` overload, which is unaffected either way.

- eb318a7: Split the confidential layer into shared cores plus an external linked library, so hosts fit under EIP-170.

  All FHE orchestration now lives in `ERC20ConfidentialLib`, an external library that must be deployed once per chain and linked into every consuming token. The logic that `FHERC20`/`FHERC20Upgradeable` and the two wrapper pairs each carried a full copy of moved into shared cores (`FHERC20Core`, `FHERC20ERC20WrapperCore`, `FHERC20NativeWrapperCore`, `ERC20ConfidentialCoreUpgradeable`), leaving the existing contracts as thin hosts.

  Breaking changes:

  - **Library linking is now mandatory.** Deploy `ERC20ConfidentialLib` and pass it via `libraries` when building any token factory (`unsafeAllowLinkedLibraries: true` for the OZ upgrades plugin). See the README.
  - **Unshield claims are re-keyed.** `claimUnshielded` and `getClaim` take a unique per-claimant id (`keccak256(to, nonce++, handle)`), not the ciphertext handle, which fixes claims with colliding handles overwriting each other. The `Claim` struct gains `id` and drops `requestedAmount`; `decryptedAmount` now holds the proven settle amount. Pending claims do NOT survive an upgrade from the old `FHERC20WrapperClaimHelper` store, so settle them before upgrading a proxy.
  - **`FHERC20WrapperClaimHelper` and `FHERC20WrapperClaimHelperUpgradeable` are removed**, replaced by `FHERC20WrapperClaims` over the library's claim store.
  - **`confidentialTotalSupply()` now returns a real registered, publicly-decryptable ciphertext** instead of an unregistered handle wrapping a plaintext. New `confidentialTotalSupplyPlaintext()` and permissionless `syncConfidentialTotalSupply()` accompany it; the plaintext saturates at `type(uint64).max` rather than reverting, so a donation to the confidential pool cannot brick shield or deadlock claims.
  - **Confidential moves are now `nonReentrant`**, which rejects reentrant callbacks that previously succeeded.
  - **`ERC20Confidential` and `ERC20ConfidentialUpgradeable` no longer nominally inherit `IERC20Confidential`** (the `IERC7984`/`IERC20ConfidentialCore` trees declare overlapping events, which Solidity rejects in one graph). The full ABI is unchanged and `supportsInterface` still answers for it.

  Additions: a `_beforeConfidentialMove` policy hook for freeze/pause, an optional compliance observer, and `shieldTo`/`autoShield` with the `MintMode`/`IMintModePolicy` opt-in policy surface for hosts that want freshly minted tokens auto-shielded.

### Patch Changes

- 6e30218: Add new 'unshield' overload function that accepts an encrypted amount.
- f473f5e: Adds 'ERC20Confidential' extension, an abstract ERC20 with a second confidential balance.
  Update Dependencies Versions.
- 29203f8: ERC20ConfidentialUpgradeable version with tests

## 0.3.1

### Patch Changes

- 20f2f3d: Extract shared FHERC20 errors to file-scope definitions in `FHERC20Errors.sol` to eliminate duplicate ABI entries across `FHERC20`, `FHERC20Upgradeable`, and `FHERC20Utils`.

## 0.3.0

### Minor Changes

- 7b2f955: Refactor ERC7984 to FHERC20 and add upgradeable variants.

  - Rename `ERC7984` contracts to `FHERC20` (`FHERC20.sol`, `FHERC20ERC20Wrapper`, `FHERC20NativeWrapper`, `FHERC20Utils`, `FHERC20WrapperClaimHelper`)
  - Remove legacy `FHERC20.sol`, `FHERC20Permit`, `FHERC20WrappedERC20`, `FHERC20WrappedNative`, `FHERC20UnshieldClaim`, and associated interfaces (`IFHERC20Errors`, `IFHERC20Permit`)
  - Add `FHERC20Upgradeable` with ERC-7201 namespaced storage for proxy-based deployments
  - Add upgradeable wrapper extensions: `FHERC20ERC20WrapperUpgradeable`, `FHERC20NativeWrapperUpgradeable`, `FHERC20WrapperClaimHelperUpgradeable`
  - Rename wrapper interfaces: `IERC7984ERC20Wrapper` → `IFHERC20ERC20Wrapper`, `IERC7984NativeWrapper` → `IFHERC20NativeWrapper`
  - Simplify `IFHERC20` to extend `IERC7984` + `IERC20` with indicator helpers
  - `FHERC20.supportsInterface` now reports `IFHERC20`, `IERC7984`, `IERC20`, and `ERC165`

## 0.2.1

### Patch Changes

- e31b762: Add ERC7984 confidential token standard.

## 0.2.0

### Minor Changes

- 485a425: Rename wrap/unwrap → shield/unshield; add FHERC20WrappedNative and decimal precision

  ### Breaking changes

  - `FHERC20Wrapper` renamed to `FHERC20WrappedERC20` (file renamed to `FHERC20WrappedERC20.sol`).
  - `FHERC20UnwrapClaim` renamed to `FHERC20UnshieldClaim` (file renamed to `FHERC20UnshieldClaim.sol`).
  - All `wrap` / `unwrap` / `claimUnwrapped` / `claimUnwrappedBatch` functions renamed to `shield` / `unshield` / `claimUnshielded` / `claimUnshieldedBatch`.
  - Events renamed: `WrappedERC20` → `ShieldedERC20`, `UnwrappedERC20` → `UnshieldedERC20`, `ClaimedUnwrappedERC20` → `ClaimedUnshieldedERC20`.
  - `FHERC20WrappedERC20.decimals()` now reports the **confidential precision** (capped at 6) rather than the underlying token's decimals.
  - `shield` now accepts the raw underlying ERC20 amount (not a pre-scaled confidential amount). Amounts are aligned to `_conversionRate` automatically; any remainder is not transferred. Reverts with `AmountTooSmallForConfidentialPrecision` if the aligned amount is zero.
  - `unshield` now accepts amounts in confidential units (6-decimal precision). Claims are returned in underlying ERC20 units scaled by `_conversionRate`.

  ### New features

  - **`FHERC20WrappedNative`** — confidential wrapper for a chain's native token (e.g. ETH). Supports two shield entry-points:
    - `shieldWrappedNative(address to, uint256 value)` — pulls WETH from the caller, unwraps it to native ETH, and mints confidential tokens.
    - `shieldNative(address to) payable` — accepts native ETH directly; dust below the `conversionRate` is automatically refunded to the caller.
    - `unshield`, `claimUnshielded`, and `claimUnshieldedBatch` send native ETH to the recipient on claim.
  - **`_conversionRate`** immutable added to `FHERC20WrappedERC20` — computed as `10^(underlyingDecimals - 6)` when the underlying has more than 6 decimals, otherwise `1`.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2025-01-21

### Added

- Initial release of FHERC20 confidential token standard
- FHERC20Permit for EIP-712 signature-based operator approval
- FHERC20Wrapper for wrapping standard ERC-20 tokens
- FHERC20UnwrapClaim for managing unwrap claims
- Comprehensive interface definitions (IFHERC20, IFHERC20Permit, IFHERC20Errors, IFHERC20Receiver)
- FHERC20Utils library for transfer callbacks
- FHESafeMath utility library
- `confidentialTransferAndCall` and `confidentialTransferFromAndCall` functions for contract callbacks

### Security

- Implemented operator model replacing traditional ERC-20 allowances
- Added indicator balance system for backwards compatibility without revealing actual amounts
