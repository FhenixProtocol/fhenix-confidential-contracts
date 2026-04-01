---
"fhenix-confidential-contracts": minor
---

Refactor ERC7984 to FHERC20 and add upgradeable variants.

- Rename `ERC7984` contracts to `FHERC20` (`FHERC20.sol`, `FHERC20ERC20Wrapper`, `FHERC20NativeWrapper`, `FHERC20Utils`, `FHERC20WrapperClaimHelper`)
- Remove legacy `FHERC20.sol`, `FHERC20Permit`, `FHERC20WrappedERC20`, `FHERC20WrappedNative`, `FHERC20UnshieldClaim`, and associated interfaces (`IFHERC20Errors`, `IFHERC20Permit`)
- Add `FHERC20Upgradeable` with ERC-7201 namespaced storage for proxy-based deployments
- Add upgradeable wrapper extensions: `FHERC20ERC20WrapperUpgradeable`, `FHERC20NativeWrapperUpgradeable`, `FHERC20WrapperClaimHelperUpgradeable`
- Rename wrapper interfaces: `IERC7984ERC20Wrapper` → `IFHERC20ERC20Wrapper`, `IERC7984NativeWrapper` → `IFHERC20NativeWrapper`
- Simplify `IFHERC20` to extend `IERC7984` + `IERC20` with indicator helpers
- `FHERC20.supportsInterface` now reports `IFHERC20`, `IERC7984`, `IERC20`, and `ERC165`
