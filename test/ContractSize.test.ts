import { expect } from "chai";
import { artifacts } from "hardhat";

// EIP-170 guard for the deployable contracts this package ships. If one of these fails, the
// contract cannot be deployed to any mainnet-equivalent chain: reclaim bytecode (compiler tuning,
// trimming a surface) before shipping.
const EIP170_LIMIT = 24576;

const PRODUCTION_CONTRACTS = ["ERC20ConfidentialLib", "FHERC20ERC20WrapperUUPS", "FHERC20NativeWrapperUUPS"];

describe("EIP-170 deployed-bytecode size", function () {
  for (const name of PRODUCTION_CONTRACTS) {
    it(`${name} fits the ${EIP170_LIMIT}-byte limit`, async function () {
      const artifact = await artifacts.readArtifact(name);
      const size = (artifact.deployedBytecode.length - 2) / 2; // strip 0x, hex → bytes
      expect(size, `${name} deployed bytecode is ${size} bytes (${size - EIP170_LIMIT} over)`).to.be.at.most(
        EIP170_LIMIT,
      );
    });
  }
});
