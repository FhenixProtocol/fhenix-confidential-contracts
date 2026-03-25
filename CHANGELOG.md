# Changelog

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
