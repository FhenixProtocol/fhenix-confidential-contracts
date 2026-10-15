import { expect } from "chai";
import { artifacts, ethers } from "hardhat";

// Consensys Diligence 5.28 — four required ERC-7984 methods had no function at their spec selector,
// because the proof-carrying variants took an `InEuint64` struct. The shared/external handle
// migration replaced those with `externalEuint64`, a bytes32 user-defined value type, so the
// selectors now match the spec exactly. This suite locks that in: a future signature change would
// silently break spec compliance again, which is exactly how the finding arose.
//
// Selectors and topic0s are derived from IERC7984's own ABI and checked against each host's
// compiled ABI, so the assertion is "every host exposes the whole interface" rather than a
// hand-copied list that can drift from the interface it claims to track.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

// The four that were absent at the audited revision, pinned by literal selector so this suite
// fails loudly if a signature drifts even if IERC7984 drifts with it.
const REPORTED_MISSING: Record<string, string> = {
  "0x2fb74e62": "confidentialTransfer(address,bytes32,bytes)",
  "0xe064b9bb": "confidentialTransferFrom(address,address,bytes32,bytes)",
  "0xde642119": "confidentialTransferAndCall(address,bytes32,bytes,bytes)",
  "0x34c45743": "confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)",
};

const HOSTS = [
  "FHERC20_Harness",
  "MockERC20Confidential",
  "ERC20ConfidentialUpgradeable_Harness",
  "FHERC20ERC20WrapperUUPS",
  "FHERC20NativeWrapperUUPS",
];

const sig = (f: { name: string; inputs: { type: string }[] }) => `${f.name}(${f.inputs.map(i => i.type).join(",")})`;

describe("ERC-7984 ABI compliance (Diligence 5.28)", function () {
  async function specSurface() {
    const abi = (await artifacts.readArtifact("IERC7984")).abi as any[];
    return {
      functions: abi.filter(f => f.type === "function").map(sig),
      events: abi.filter(f => f.type === "event").map(sig),
    };
  }

  async function hostSurface(name: string) {
    const abi = (await artifacts.readArtifact(name)).abi as any[];
    return {
      functions: new Set(abi.filter(f => f.type === "function").map(sig)),
      events: new Set(abi.filter(f => f.type === "event").map(sig)),
    };
  }

  it("IERC7984 declares the surface this suite checks", async function () {
    const spec = await specSurface();
    // Guards against the interface being gutted and every host trivially "complying".
    expect(spec.functions.length).to.be.at.least(16);
    expect(spec.events).to.include("ConfidentialTransfer(address,address,bytes32)");
  });

  for (const host of HOSTS) {
    it(`${host} exposes every IERC7984 function at its spec selector`, async function () {
      const spec = await specSurface();
      const have = await hostSurface(host);
      const missing = spec.functions.filter(s => !have.functions.has(s));
      expect(missing, `${host} is missing: ${missing.join(", ")}`).to.deep.equal([]);
    });

    it(`${host} carries the four selectors reported absent`, async function () {
      const have = await hostSurface(host);
      const bySelector = new Map([...have.functions].map(s => [ethers.id(s).slice(0, 10), s]));
      for (const [selector, signature] of Object.entries(REPORTED_MISSING)) {
        expect(bySelector.get(selector), `${host} lacks ${signature} at ${selector}`).to.equal(signature);
      }
    });
  }

  // AmountDisclosed is asserted only on the FHERC20 family. The ERC20Confidential family
  // implements no on-chain disclosure surface by design: an ACP shares one value with one named
  // recipient off-chain, whereas discloseEncryptedAmount publishes the plaintext to everyone. Its
  // absence is not asserted either, so adding it later would not break this suite.
  it("every host emits the transfer and operator events at their spec topic0", async function () {
    const shared = ["ConfidentialTransfer(address,address,bytes32)", "OperatorSet(address,address,uint48)"];
    for (const host of HOSTS) {
      const have = await hostSurface(host);
      for (const ev of shared) {
        expect(have.events.has(ev), `${host} is missing event ${ev}`).to.equal(true);
      }
    }
  });

  it("the FHERC20 family also emits AmountDisclosed", async function () {
    const have = await hostSurface("FHERC20_Harness");
    expect(have.events.has("AmountDisclosed(bytes32,uint64)")).to.equal(true);
  });

  describe("advertises ERC-7984 through ERC-165", function () {
    let interfaceId: string;

    before(async function () {
      const abi = (await artifacts.readArtifact("IERC7984")).abi as any[];
      // Solidity's `type(IERC7984).interfaceId` XORs only the functions the interface DECLARES.
      // IERC7984 inherits IERC165, and the flattened artifact ABI folds `supportsInterface` in, so
      // it has to come out again — leaving exactly the 16 methods the finding counts.
      const declared = abi.filter(e => e.type === "function" && e.name !== "supportsInterface");
      expect(declared.length).to.equal(16);
      let x = 0n;
      for (const f of declared) x ^= BigInt(ethers.id(sig(f)).slice(0, 10));
      interfaceId = "0x" + x.toString(16).padStart(8, "0");
    });

    it("MockERC20Confidential", async function () {
      const lib = await ethers.deployContract(LIB_FQN);
      await lib.waitForDeployment();
      const f = await ethers.getContractFactory("MockERC20Confidential", {
        libraries: { [LIB_FQN]: await lib.getAddress() },
      });
      const token = await f.deploy("Confidential Token", "CTK", 18);
      await token.waitForDeployment();

      expect(await token.supportsInterface(interfaceId)).to.equal(true);
      expect(await token.supportsInterface("0xdeadbeef")).to.equal(false);
    });

    it("FHERC20_Harness", async function () {
      const token = await (await ethers.getContractFactory("FHERC20_Harness")).deploy("Asset", "AST", 6, "");
      await token.waitForDeployment();

      expect(await token.supportsInterface(interfaceId)).to.equal(true);
      expect(await token.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });
});
