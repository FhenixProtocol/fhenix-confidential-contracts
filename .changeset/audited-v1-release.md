---
"fhenix-confidential-contracts": major
---

1.0.0: the Consensys Diligence audited release.

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
