---
"fhenix-confidential-contracts": major
---

ERC20Confidential: the confidential pool and the indicator marker now use 7984 (the ERC number), matching FHERC20.

- **`CONFIDENTIAL_POOL` moves** from `0x1011000000000000000000000000000000000000` to `0x7984000000000000000000000000000000000000`. The address is a compile-time constant, so a token already deployed on the old one must NOT be upgraded to this version without migrating the pool's ledger balance: the backing of every confidential balance would be left at the old address.
- **`ERC20ConfidentialIndicator`** shows `7984.xxxx` instead of `1011000.xxxx` (marker `79_840_000` at 4 decimals) and is named `7984 <parent name>`. The fractional digits behave as before (first receive `.5001`, first send `.4999`).
