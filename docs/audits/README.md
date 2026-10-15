# Audits

## Consensys Diligence, September 2026

The contracts in this package were reviewed by Consensys Diligence as part of a wider Fhenix
engagement that also covered several products built on top of them. The library contracts were
audited in that product codebase and are published here unchanged except for comments. The only
code difference is that this package does not ship product-specific hosts.

Fixes were completed on 2 September 2026 and released in `fhenix-confidential-contracts`
1.0.0.

### Findings that apply to this package

| ID   | Severity       | Status       | Component                           | Finding                                                                                           |
| ---- | -------------- | ------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| 5.13 | Medium         | Fixed        | FHERC20 wrappers                    | An unshield to a recipient that cannot receive the payout is permanently locked in the wrapper.   |
| 5.15 | Medium         | Acknowledged | FHERC20 core                        | Operator approval lets the operator read the holder's exact balance.                              |
| 5.16 | Minor          | Fixed        | FHERC20 core, ERC20Confidential     | A recipient can spend an incoming transfer inside the receiver callback and then reject it.       |
| 5.18 | Minor          | Fixed        | ERC20ConfidentialIndicator          | Indicator `balanceOf` returns a nonzero floor for every address while `totalSupply()` stays zero. |
| 5.28 | Minor          | Fixed        | ERC20Confidential                   | ERC-7984 required methods missing at the spec ABI, and ERC-7984 not advertised via ERC-165.       |
| 5.30 | Minor          | Fixed        | IERC7984Receiver                    | The receiver's obligation to grant its returned `ebool` to the token is undocumented.             |
| 5.31 | Recommendation | Fixed        | FHERC20 wrappers, ERC20Confidential | Reentrancy guards are applied asymmetrically on the shield and claim paths.                       |
| 5.32 | Minor          | Fixed        | ERC20ConfidentialLib, FHERC20Core   | `verifyDecryptResult`'s result is not consistently checked.                                       |
| 5.33 | Recommendation | Fixed        | ERC20ConfidentialCoreUpgradeable    | The confidential issuer mint bypasses the `_beforeConfidentialMove` policy hook.                  |

Finding 5.1 (Critical) was raised against a product contract, but its root cause was the raw
`euint64` boundary pattern. This package closed that pattern before the audit by moving every
contract-to-contract boundary onto `sharedEuint64` / `sharedEbool` (0.4.0).

### What changed

- **5.13**: Both wrappers gain `reassignClaim(id, newTo)`. The native wrapper also gains
  `claimUnshieldedAsWETH`. Both are callable only by the claim's recipient or their operator, and
  a claim keeps its id, so an existing decryption proof stays valid. The remaining risk is a
  recipient that can neither receive the payout nor make an outbound call (for example, an
  address nobody controls). Such a claim cannot be recovered.
- **5.15**: No change. An operator already has full authority over the holder's funds, so
  reading the amount is accepted.
- **5.16**: The recipient's balance handle is compared before and after the callback. The
  transfer reverts with `FHERC20ReceiverMovedBalance` / `ConfidentialReceiverMovedBalance` if it
  moved. This is a defence in depth: the reentrancy guards already prevented the move.
- **5.18**: `balanceOf` reads 0 until an account's first confidential operation, and
  `totalSupply()` tracks the indicated sum. `balanceOfIsIndicator()` and `indicatorTick()` let
  integrators detect the scheme. As a result, wallets hide the token for addresses with no
  confidential activity.
- **5.28**: All 16 ERC-7984 methods resolve at their spec selectors on every host, and
  `type(IERC7984).interfaceId` is advertised via ERC-165. `discloseEncryptedAmount` is
  intentionally not added to the `ERC20Confidential` family.
- **5.30**: The receiver boundary is typed as `sharedEuint64` / `sharedEbool`, and
  `IERC7984Receiver` documents the obligation. A receiver that skips it makes the transfer revert
  with `NotShared`; the skipped answer is not read as a rejection.
- **5.31**: `nonReentrant` is applied uniformly. 11 functions across both wrapper cores and the
  confidential core are newly guarded.
- **5.32**: Both sites use `FHE.verifyDecryptResultSafe` and revert with `InvalidDecryptionProof`.
- **5.33**: `_confidentialMint` calls `_beforeConfidentialMove(address(0), to)`.

Each fix is pinned by regression tests in [`test/`](../../test). Most are named after the
finding, for example `ConfidentialMintHook.test.ts`, `ReentrancyGuardUniformity.test.ts` and
`ERC7984Compliance.test.ts`.

### Not audited

`FHERC20ERC20WrapperUUPS` and `FHERC20NativeWrapperUUPS` are **not audited**. They were added
after the fix review and were not part of the Diligence engagement. Each is
a thin host: it adds `Ownable2StepUpgradeable` and `UUPSUpgradeable` to the audited upgradeable
wrapper, with `_authorizeUpgrade` restricted to the owner. They add no balance or claim logic.
