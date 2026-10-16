import { expect } from "chai";
import { ethers } from "hardhat";

// Consensys Diligence 5.33 — the core funnels confidential moves through
// `_beforeConfidentialMove` and used to document one exemption: "Issuer mint/burn deliberately do
// NOT call this." The other documented exemptions (`shield`, `claimUnshielded`) resolve to a real
// inherited guard, because their ledger leg is `_ledgerTransfer` and a public transfer hook gates
// it. `_confidentialMint`'s ledger leg is `_ledgerMint`, and a public-ledger base is not obliged
// to offer a mint hook. So on a freeze- or pause-bearing host whose base has none, NOTHING gated
// the mint.
//
// `_confidentialMint` now calls the hook with `from == address(0)`. These tests use
// ConfidentialHarness, whose hook enforces a representative pause + freeze policy, so they prove
// the gate actually engages instead of just that the call happens.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("confidential issuer mint policy hook (Diligence 5.33)", function () {
  async function deploy() {
    const [, bob] = await ethers.getSigners();

    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const Harness = await ethers.getContractFactory("ConfidentialHarness", {
      libraries: { [LIB_FQN]: await lib.getAddress() },
    });
    const token = await Harness.deploy();
    await token.waitForDeployment();
    await (await token.initialize(6)).wait();

    return { token, bob };
  }

  const AMOUNT = 1_000_000n;

  it("CONTROL: an issuer mint succeeds when the host is neither paused nor freezing", async function () {
    const { token, bob } = await deploy();
    await expect(token.mint(bob.address, AMOUNT)).to.emit(token, "ConfidentialTransfer");
  });

  it("is blocked while the host is paused", async function () {
    const { token, bob } = await deploy();

    await token.setPaused(true);

    // Before the fix this minted confidential balance straight through a paused token: the
    // confidential hook was skipped by design and the ledger mint offered no hook to fall back on.
    await expect(token.mint(bob.address, AMOUNT)).to.be.revertedWith("paused");
  });

  it("is blocked when the recipient is frozen", async function () {
    const { token, bob } = await deploy();

    await token.setBlocked(bob.address, true);

    await expect(token.mint(bob.address, AMOUNT)).to.be.revertedWith("frozen");
  });

  it("resumes after unpause, and after the recipient is unfrozen", async function () {
    const { token, bob } = await deploy();

    await token.setPaused(true);
    await expect(token.mint(bob.address, AMOUNT)).to.be.revertedWith("paused");

    await token.setPaused(false);
    await expect(token.mint(bob.address, AMOUNT)).to.emit(token, "ConfidentialTransfer");

    await token.setBlocked(bob.address, true);
    await expect(token.mint(bob.address, AMOUNT)).to.be.revertedWith("frozen");

    await token.setBlocked(bob.address, false);
    await expect(token.mint(bob.address, AMOUNT)).to.emit(token, "ConfidentialTransfer");
  });

  it("a zero `from` does not itself trip the freeze check", async function () {
    const { token, bob } = await deploy();

    // The hook is called as (address(0), to). The fix relies on a zero address never being
    // frozen — if that stopped holding, every issuer mint would revert. Pin it.
    expect(await token.blocked(ethers.ZeroAddress)).to.equal(false);
    await expect(token.mint(bob.address, AMOUNT)).to.emit(token, "ConfidentialTransfer");
  });
});
