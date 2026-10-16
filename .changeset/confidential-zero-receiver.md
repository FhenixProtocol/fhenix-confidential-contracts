---
"fhenix-confidential-contracts": patch
---

Reject `address(0)` as the receiver of `ERC20ConfidentialLib.confidentialMint` and `ERC20ConfidentialLib.shieldTo`.

Neither function checked its receiver, unlike `FHERC20Core._mint`:

- `confidentialMint(address(0), x)` minted `x` public backing into `CONFIDENTIAL_POOL` while the confidential credit landed on no account.
- `shieldTo(address(0), x)` passed the zero receiver into the `from` slot of the self-only `__ledger` bridge, which reads a zero `from` as a mint, with the same result.

In both cases `x` public supply ended up locked in the pool: owned by no confidential balance, never unshieldable, yet counted in `confidentialTotalSupply`. Nothing was extractable, and the in-repo hosts cannot reach the `shieldTo` case (`shield` always uses `msg.sender`), so this is defense-in-depth for hosts that call `confidentialMint`, `shieldTo` or `autoShield` with a caller-supplied receiver.

Both now revert with `ConfidentialInvalidReceiver(address(0))`. `autoShield` stays best-effort and returns early for a zero receiver instead of reverting. No selector, event or storage change.

`ERC20ConfidentialLib` bytecode changes: the fix takes effect for a token only after the new library is deployed and the host is relinked to it.
