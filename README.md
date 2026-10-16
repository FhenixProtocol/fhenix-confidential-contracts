# Fhenix Confidential Contracts

[![NPM Package](https://img.shields.io/npm/v/fhenix-confidential-contracts.svg)](https://www.npmjs.org/package/fhenix-confidential-contracts)
[![CI Status](https://github.com/FhenixProtocol/fhenix-confidential-contracts/actions/workflows/test.yml/badge.svg)](https://github.com/FhenixProtocol/fhenix-confidential-contracts/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Confidential ERC-20 tokens for Fhenix CoFHE: an ERC-7984 (FHERC-20) implementation, confidential
wrappers for ERC-20 and native tokens, and a dual-ledger confidential layer for existing ERC-20s.**

Balances and transfer amounts are encrypted on-chain with Fully Homomorphic Encryption, while the
contracts still expose a standard token surface to wallets and indexers.

> **Audit status.** The contracts in this package were reviewed by Consensys Diligence (September
> 2026), except the two UUPS wrapper hosts (`FHERC20ERC20WrapperUUPS`, `FHERC20NativeWrapperUUPS`),
> which are not audited. Every finding that applies to the audited contracts is fixed or
> acknowledged; see [docs/audits](./docs/audits/README.md) for the scope and per-finding outcomes.

## What's in the package

| Contract                                                   | Use it to                                                                                                       |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `FHERC20` / `FHERC20Upgradeable`                           | Build a fully confidential token (ERC-7984 + FHERC-20 indicator layer).                                         |
| `FHERC20ERC20Wrapper` / `FHERC20ERC20WrapperUpgradeable`   | Wrap an existing ERC-20 into a confidential token.                                                              |
| `FHERC20NativeWrapper` / `FHERC20NativeWrapperUpgradeable` | Wrap the chain's native token (or WETH) into a confidential token.                                              |
| `FHERC20ERC20WrapperUUPS` / `FHERC20NativeWrapperUUPS`     | Deploy a wrapper as-is behind an `ERC1967Proxy`: concrete, ownable (2-step), UUPS-upgradeable. **Not audited.** |
| `ERC20Confidential` / `ERC20ConfidentialUpgradeable`       | Add a confidential balance layer to a token that keeps its public ERC-20 ledger.                                |
| `ERC20ConfidentialCoreUpgradeable`                         | Mix the confidential layer into a host that already brings its own ERC-20 + OpenZeppelin stack.                 |
| `ERC20ConfidentialLib`                                     | The external library every confidential host links against (deploy once per chain).                             |

## Installation

```bash
pnpm add fhenix-confidential-contracts
# or: npm install fhenix-confidential-contracts / yarn add fhenix-confidential-contracts
```

For Foundry:

```bash
forge install FhenixProtocol/fhenix-confidential-contracts
```

### Requirements

- Solidity `^0.8.25`, EVM target `cancun` (the contracts use transient storage for reentrancy guards).
- [`@fhenixprotocol/cofhe-contracts`](https://github.com/FhenixProtocol/cofhe-contracts) `1.0.0`.
- Client-side encryption with `@cofhe/sdk` `0.8.x` (tests use `@cofhe/hardhat-plugin` `0.8.x`).

## Linking `ERC20ConfidentialLib` (required)

The confidential FHE orchestration and unshield-claim bookkeeping live in `ERC20ConfidentialLib`,
an **external library** that is `delegatecall`ed by the token. Keeping it out of the token is what
keeps confidential tokens under the EIP-170 24 KB limit.

Every contract that inherits `ERC20Confidential*` or either wrapper must be linked against it at
deploy time. The address is baked into the token's bytecode and **cannot be changed afterwards**.
Plain `FHERC20` / `FHERC20Upgradeable` do not use the library.

```ts
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

// 1. Deploy the library once per chain. deploy/00_deploy_confidential_lib.ts does this, forces
//    explorer verification, and records the address under deployments/<network>/.
const lib = await ethers.deployContract(LIB_FQN);
await lib.waitForDeployment();

// 2. Link it into every token factory.
const factory = await ethers.getContractFactory("MyConfidentialToken", {
  libraries: { [LIB_FQN]: await lib.getAddress() },
});

// 3. Upgradeable tokens additionally need the OZ upgrades plugin to allow linked libraries.
await upgrades.deployProxy(factory, [...args], { unsafeAllowLinkedLibraries: true });
```

Forgetting step 2 fails at deploy time with an unresolved-link error, not silently.

> Library instances deployed from a 0.x release are **not** the audited code. 1.0.0 hosts must
> link against a library deployed from 1.0.0.

## Usage

### A confidential token

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20 } from "fhenix-confidential-contracts/contracts/FHERC20/FHERC20.sol";

contract MyConfidentialToken is FHERC20 {
  constructor() FHERC20("My Confidential Token", "eMCT", 6, "") {
    _mint(msg.sender, FHE.asEuint64(1_000_000 * 10 ** 6));
  }
}
```

Balances are `euint64` (at most ~1.8 × 10¹⁹ base units), so 6 decimals is the practical ceiling.
The wrappers and `ERC20Confidential` cap their confidential decimals at 6 automatically.

### Wrapping an existing ERC-20

For a production deployment, use the ready-made UUPS host behind an `ERC1967Proxy`:

```ts
const impl = await(
  await ethers.getContractFactory("FHERC20ERC20WrapperUUPS", {
    libraries: { [LIB_FQN]: libAddress },
  }),
).deploy();

const initData = impl.interface.encodeFunctionData("initialize", [
  underlying, // the ERC-20 being wrapped; decimals are taken from it, capped at 6
  "Confidential USDC",
  "eUSDC",
  "", // contractURI
  multisig, // owner: holds upgrade authority, nothing else
]);
const proxy = await(await ethers.getContractFactory("ERC1967Proxy")).deploy(await impl.getAddress(), initData);
```

`FHERC20NativeWrapperUUPS` is the same, initialized with the chain's WETH instead of an ERC-20.

The owner's only power is authorizing upgrades, and an upgrade can move everything the wrapper
holds. **Use a multisig.** Ownership transfers in two steps (`transferOwnership`, then
`acceptOwnership`).

The wrapper lifecycle:

1. **Shield.** Approve the wrapper, then `shield(to, amount)`. ERC-1363 `transferAndCall` also
   works. Native wrappers use `shieldNative(to)` (payable) or `shieldWrappedNative(to, value)`.
2. **Unshield.** `unshield(from, to, amount)` burns the confidential balance and records a pending
   claim for `to`. The claim id comes from `getUserClaims(to)`.
3. **Decrypt.** Obtain a threshold-network decryption proof for the claim's `ctHash` (via `@cofhe/sdk`).
4. **Claim.** Anyone may call `claimUnshielded(id, decryptedAmount, proof)`. It pays `to`.
   `claimUnshieldedBatch` settles several claims at once.

If the recipient cannot accept the payout (for example, a contract with no payable fallback, or
an address the underlying token blocks), the recipient or their operator can redirect it with
`reassignClaim(id, newTo)`. On native wrappers they can instead settle in WETH with
`claimUnshieldedAsWETH`. The claim keeps its id, so a proof obtained earlier stays valid.

### Adding a confidential layer to an ERC-20

```solidity
import { ERC20Confidential } from "fhenix-confidential-contracts/contracts/ERC20Confidential/ERC20Confidential.sol";

contract MyDualToken is ERC20Confidential {
  // 18 public decimals; the confidential layer uses 6, at a conversion rate of 10 ** 12.
  constructor() ERC20Confidential("My Dual Token", "MDT", 18) {}
}
```

Holders move value between the public ledger and the confidential one with `shield(amount)` and
`unshield(amount)` + `claimUnshielded`. Override `_beforeConfidentialMove(from, to)` to apply
pause or freeze policy. It runs on every confidential transfer, on `unshield`, and on issuer
mints (`from == address(0)`).

## Key concepts

### Encrypted inputs

User-facing entry points take an `externalEuint64` handle plus the batch `inputProof` produced by
`@cofhe/sdk`. Contract-to-contract calls use the `sharedEuint64` overloads instead: the calling
contract shares the handle with `FHE.shareEuint64(handle, token)`, and reads results with
`FHE.receiveEuint64FromCall(returned, token)`.

```ts
const [encAmount, inputProof] = await client
  .encryptInputs([Encryptable.uint64(amount)])
  .setConsumingContract(tokenAddress)
  .execute();

await token["confidentialTransfer(address,bytes32,bytes)"](to, encAmount, inputProof);
```

On the `*AndCall` overloads, `inputProof` comes before `bytes data`.

### Receivers

`confidentialTransferAndCall` calls `IERC7984Receiver.onConfidentialTransferReceived` on the
recipient. A receiver must unwrap the amount with `FHE.receiveEuint64Param(amount)` and return its
answer as `FHE.shareEbool(result, msg.sender)`. If it returns an unshared value, the transfer
reverts with `NotShared`; it is not treated as a rejection. A receiver that moves its own balance
during the callback makes the transfer revert.

### Operators instead of allowances

Allowances would leak encrypted amounts, so ERC-7984 replaces them with time-limited operators.
An operator can move **any** amount on the holder's behalf until `until`, and can read the
holder's balance. Keep deadlines short.

```solidity
token.setOperator(spender, uint48(block.timestamp + 1 hours));
```

### Indicated balances

On FHERC20 tokens, `balanceOf` returns an _indicator_ rather than the real balance. It is a
small value that changes on activity, so wallets and explorers notice movement without seeing
amounts. `ERC20Confidential` keeps its real public `balanceOf` and publishes the indicator through
a companion `ERC20ConfidentialIndicator` token instead. Accounts with no confidential activity
read `0`. Integrators can detect the scheme with `balanceOfIsIndicator()` and `indicatorTick()`.

## Contract architecture

Behavior lives in shared `*Core` mixins. The concrete contracts are thin hosts that supply setup
(constructor vs. initializer) and ERC-165 answers.

```
ERC20ConfidentialLib (external, linked, delegatecall'd - deploy once per chain)
  ▲ used by the wrapper cores and the confidential core

FHERC20Core (encrypted balances, operators, indicator layer, disclosure)
├── FHERC20                                   (constructor host)
├── FHERC20Upgradeable                        (initializer host)
├── FHERC20ERC20WrapperCore                   (shield / unshield / claim)
│   ├── FHERC20ERC20Wrapper
│   └── FHERC20ERC20WrapperUpgradeable
│       └── FHERC20ERC20WrapperUUPS           (deployable: Ownable2Step + UUPS)
└── FHERC20NativeWrapperCore                  (native / WETH shield / unshield / claim)
    ├── FHERC20NativeWrapper
    └── FHERC20NativeWrapperUpgradeable
        └── FHERC20NativeWrapperUUPS          (deployable: Ownable2Step + UUPS)

ERC20ConfidentialCoreUpgradeable (confidential layer over a host's public ERC-20; reaches the
│   ledger through _ledgerMint / _ledgerTransfer / _ledgerBalanceOf and gates moves through
│   _beforeConfidentialMove)
├── ERC20Confidential                         (constructor host, OZ ERC20 ledger)
└── ERC20ConfidentialUpgradeable              (initializer host, OZ ERC20Upgradeable ledger)

Interfaces: IERC7984, IERC7984Receiver, IFHERC20, IERC20Confidential, IERC20ConfidentialCore,
            IFHERC20ERC20Wrapper, IFHERC20NativeWrapper, IWETH
Utilities:  FHERC20Utils, FHERC20Errors, FHERC20WrapperClaims, ERC20ConfidentialIndicator, FHESafeMath
```

Unshield claims are keyed by a unique per-claimant id, not by the ciphertext handle. CoFHE
handles are content-addressed, so two identical unshields would otherwise collide. The handle is
kept as `Claim.ctHash` to bind the decryption proof.

## Security

- **Reentrancy.** Every function that moves a balance or pays out is `nonReentrant`. Overriders
  that extend `claimUnshielded` through `super` must not add a second guard, or the call deadlocks.
- **Operators** have full transfer authority and balance visibility until their deadline.
- **Indicators** reveal activity, not amounts.
- **Decryption proofs** are checked with `FHE.verifyDecryptResultSafe`. A bad proof reverts with
  `InvalidDecryptionProof`.
- **Wrapper upgrades** can move every asset the wrapper holds. The UUPS owner should be a multisig.

Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## Development

```bash
pnpm install
pnpm compile
pnpm test        # full suite against the CoFHE mocks
pnpm gas         # with gas reporting
pnpm format
pnpm lint
```

Releases are managed with [Changesets](https://github.com/changesets/changesets): add one with
`pnpm changeset` in any PR that changes published contracts.

## Contributing

Contributions are welcome. Please read the [Contributing Guide](./CONTRIBUTING.md) first.

## License

Released under the [MIT License](./LICENSE).
