# Changelog

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
