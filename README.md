# Fhenix Confidential Contracts

[![NPM Package](https://img.shields.io/npm/v/fhenix-confidential-contracts.svg)](https://www.npmjs.org/package/fhenix-confidential-contracts)
[![CI Status](https://github.com/FhenixProtocol/fhenix-confidential-contracts/actions/workflows/test.yml/badge.svg)](https://github.com/FhenixProtocol/fhenix-confidential-contracts/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**A privacy-preserving FHERC-20 token standard implementation built on Fhenix Protocol's Fully Homomorphic Encryption (FHE).**

> **Warning**: These contracts are in active development and have not been audited. Use at your own risk.

## Overview

This library provides Solidity smart contracts for confidential ERC-20 tokens using FHE. Token balances and transfer amounts remain encrypted on-chain while still supporting standard token operations.

### Key Features

- **FHERC20** - Base confidential token with encrypted balances
- **FHERC20Permit** - EIP-712 signature-based operator approval
- **FHERC20Wrapper** - Wrap standard ERC-20 tokens into confidential tokens
- **FHERC20UnwrapClaim** - Claim management for unwrapping back to ERC-20

## Installation

### Hardhat (npm/yarn/pnpm)

```bash
npm install fhenix-confidential-contracts
# or
yarn add fhenix-confidential-contracts
# or
pnpm add fhenix-confidential-contracts
```

### Foundry

```bash
forge install FhenixProtocol/fhenix-confidential-contracts
```

## Usage

### Basic FHERC20 Token

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHERC20 } from "fhenix-confidential-contracts/contracts/FHERC20.sol";

contract MyConfidentialToken is FHERC20 {
    constructor() FHERC20("My Confidential Token", "eMCT", 18) {
        // Mint initial supply to deployer
        _mint(msg.sender, 1000000 * 10**18);
    }
}
```

### FHERC20 with Permit

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHERC20 } from "fhenix-confidential-contracts/contracts/FHERC20.sol";
import { FHERC20Permit } from "fhenix-confidential-contracts/contracts/FHERC20Permit.sol";

contract MyPermitToken is FHERC20, FHERC20Permit {
    constructor()
        FHERC20("My Permit Token", "eMPT", 18)
        FHERC20Permit("My Permit Token")
    {
        _mint(msg.sender, 1000000 * 10**18);
    }
}
```

### Wrapping Existing ERC-20 Tokens

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHERC20Wrapper } from "fhenix-confidential-contracts/contracts/FHERC20Wrapper.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MyWrappedToken is FHERC20Wrapper {
    constructor(IERC20 underlyingToken)
        FHERC20Wrapper(underlyingToken, "")
    {}
}

// Usage:
// 1. Deploy with existing ERC-20 address
// 2. Approve the wrapper contract to spend your ERC-20 tokens
// 3. Call wrap(recipient, amount) to mint confidential tokens
// 4. Call unwrap(recipient, encryptedAmount) to initiate unwrapping
// 5. Call claimUnwrapped(ctHash) after decryption completes
```

## Contract Architecture

```
FHERC20 (base)
├── FHERC20Permit (EIP-712 signatures)
└── FHERC20Wrapper (ERC-20 wrapping)
    └── FHERC20UnwrapClaim (claim management)

Interfaces:
├── IFHERC20
├── IFHERC20Permit
├── IFHERC20Errors
├── IFHERC20Receiver
└── IWETH

Utilities:
├── FHERC20Utils
└── FHESafeMath
```

## Key Concepts

### Indicated Balances

FHERC20 tokens use an "indicator" system for backwards compatibility with existing ERC-20 infrastructure (wallets, block explorers). The `balanceOf` function returns a value between `0.0000` and `0.9999` that indicates balance changes without revealing actual amounts.

This allows wallets to detect when balances change while keeping the actual amounts private.

### Operators vs Allowances

Traditional ERC-20 allowances are replaced with time-limited **operators** to prevent encrypted balance leakage. Unlike allowances where you approve a specific amount, operators can transfer any amount on behalf of a holder until their permission expires.

```solidity
// Set an operator (replaces approve)
token.setOperator(spender, deadline);

// Check if address is an operator
bool isOp = token.isOperator(holder, spender);

// Transfer as operator (replaces transferFrom with allowance)
token.confidentialTransferFrom(from, to, encryptedAmount);
```

### Confidential Transfers

```solidity
// Direct encrypted transfer
token.confidentialTransfer(to, encryptedAmount);

// Operator-initiated transfer
token.confidentialTransferFrom(from, to, encryptedAmount);

// Transfer with callback to receiving contract
token.confidentialTransferAndCall(to, encryptedAmount, data);
```

## Security Considerations

### FHE-Specific Security

1. **Balance Indicators Are Public**: The indicator values (0.0000-0.9999) reveal transfer activity but not amounts
2. **Operator Model**: Operators have full transfer authority during their approval period - use short deadlines
3. **Decryption Delays**: Unwrapping operations require waiting for FHE decryption to complete

### Smart Contract Security

1. **Reentrancy**: `confidentialTransferAndCall` includes callback functionality - receiving contracts should follow checks-effects-interactions
2. **Integer Operations**: FHE operations have different overflow behavior than standard Solidity

### Audit Status

> **Warning**: These contracts have not been audited. A security audit is planned before v1.0.0 release.

### Reporting Vulnerabilities

Please report security vulnerabilities through our [Security Policy](./SECURITY.md).

## Dependencies

- [@openzeppelin/contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) ^5.2.0
- [@fhenixprotocol/cofhe-contracts](https://github.com/FhenixProtocol/cofhe-contracts) 0.0.13

## Development

```bash
# Install dependencies
pnpm install

# Compile contracts
pnpm compile

# Run tests
pnpm test

# Run tests with gas reporting
pnpm gas

# Format code
pnpm format

# Lint
pnpm lint
```

## Contributing

Contributions are welcome! Please read our [Contributing Guide](./CONTRIBUTING.md) before submitting a Pull Request.

## License

Released under the [MIT License](./LICENSE).
