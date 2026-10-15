import { expect } from "chai";
import hre, { ethers } from "hardhat";

// Validates the compliance-observer feature AND the EIP-170 relocation of
// shield/unshield/mint into ERC20ConfidentialLib (reached via the self-only
// `__ledger` bridge), against the real CoFHE mocks. Uses a minimal confidential
// token harness that shares the exact core + library production hosts use.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";
const POOL = "0x1011000000000000000000000000000000000000";

async function deployHarness() {
  const lib = await ethers.deployContract(LIB_FQN);
  await lib.waitForDeployment();
  const Harness = await ethers.getContractFactory("ConfidentialHarness", {
    libraries: { [LIB_FQN]: await lib.getAddress() },
  });
  const h = await Harness.deploy();
  await h.waitForDeployment();
  await (await h.initialize(6)).wait(); // 6 decimals → conversionRate = 1 (1:1)
  return h;
}

describe("Confidential observer + relocation", () => {
  it("mint routes through the __ledger bridge and credits a confidential balance", async () => {
    const [, alice] = await ethers.getSigners();
    const h = await deployHarness();

    await (await h.mint(alice.address, 100)).wait();

    await hre.cofhe.mocks.expectPlaintext(await h.confidentialBalanceOf(alice.address), 100n);
    expect(await h.ledger(POOL)).to.equal(100n); // backing minted into the pool via the bridge
  });

  it("shield routes through the __ledger bridge (public → confidential)", async () => {
    const [, alice] = await ethers.getSigners();
    const h = await deployHarness();

    await (await h.ledgerMintPublic(alice.address, 100)).wait(); // give alice public balance
    await (await h.connect(alice).shield(100)).wait();

    await hre.cofhe.mocks.expectPlaintext(await h.confidentialBalanceOf(alice.address), 100n);
    expect(await h.ledger(alice.address)).to.equal(0n);
    expect(await h.ledger(POOL)).to.equal(100n);
  });

  // NOTE: the CoFHE mock derives handles deterministically from value, and ACL
  // grants persist across tests in one run — so each ACL test uses a UNIQUE
  // amount (→ unique handle) and a UNIQUE observer signer to avoid cross-test
  // grant leakage.
  it("forward observer: an observer set BEFORE a move gains ACL on the new handles", async () => {
    const [, alice, observer] = await ethers.getSigners();
    const h = await deployHarness();
    const acl = await hre.cofhe.mocks.getMockACL();

    await (await h.setObserverPublic(observer.address)).wait();
    await (await h.mint(alice.address, 111)).wait();

    const bal = await h.confidentialBalanceOf(alice.address);
    expect(await acl.isAllowed.staticCall(BigInt(bal), observer.address)).to.equal(true);
  });

  it("no observer set: the observer has no access", async () => {
    const [, alice, , observer3] = await ethers.getSigners();
    const h = await deployHarness();
    const acl = await hre.cofhe.mocks.getMockACL();

    await (await h.mint(alice.address, 222)).wait();
    const bal = await h.confidentialBalanceOf(alice.address);
    expect(await acl.isAllowed.staticCall(BigInt(bal), observer3.address)).to.equal(false);
  });

  it("past observer: grantObserverPast grants ACL on a pre-existing handle", async () => {
    const [, alice, , , observer4] = await ethers.getSigners();
    const h = await deployHarness();
    const acl = await hre.cofhe.mocks.getMockACL();

    // Mint with NO observer → handle the observer can't see yet.
    await (await h.mint(alice.address, 333)).wait();
    const bal = BigInt(await h.confidentialBalanceOf(alice.address));
    expect(await acl.isAllowed.staticCall(bal, observer4.address)).to.equal(false);

    // Top up access to that historical handle.
    await (await h.grantPastPublic(observer4.address, [bal])).wait();
    expect(await acl.isAllowed.staticCall(bal, observer4.address)).to.equal(true);
  });

  it("_beforeConfidentialMove hook gates unshield on pause and freeze", async () => {
    const [, alice] = await ethers.getSigners();
    const h = await deployHarness();
    await (await h.mint(alice.address, 100)).wait();

    const unshield = (signer: typeof alice) => h.connect(signer).getFunction("unshield(uint64)");

    await (await h.setPaused(true)).wait();
    await expect(unshield(alice)(1)).to.be.revertedWith("paused");
    await (await h.setPaused(false)).wait();

    await (await h.setBlocked(alice.address, true)).wait();
    await expect(unshield(alice)(1)).to.be.revertedWith("frozen");
  });
});
