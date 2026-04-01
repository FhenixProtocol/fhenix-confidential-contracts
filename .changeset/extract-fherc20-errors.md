---
"fhenix-confidential-contracts": patch
---

Extract shared FHERC20 errors to file-scope definitions in `FHERC20Errors.sol` to eliminate duplicate ABI entries across `FHERC20`, `FHERC20Upgradeable`, and `FHERC20Utils`.
