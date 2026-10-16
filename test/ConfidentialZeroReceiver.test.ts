import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ZeroAddress } from "ethers";
import { ConfidentialHarness } from "../typechain-types";

// `ERC20ConfidentialLib.confidentialMint` and `shieldTo` had no zero-receiver guard.
//  - `confidentialMint(address(0), x)` minted `x` public backing into CONFIDENTIAL_POOL while the
//    confidential credit landed on no account: unowned, never-unshieldable backing.
//  - `shieldTo(address(0), x)` had the same result by another route: the `__ledger` bridge reads a
//    zero `from` as a MINT, so the "move from `to` into the pool" leg minted `x` into the pool.
// Neither was extractable; this is defense-in-depth for hosts passing a caller-supplied receiver.
// Both now revert `ConfidentialInvalidReceiver(address(0))`, like `FHERC20Core._mint`, and the
// best-effort `autoShield` returns early instead of reverting.
const SEED = 7_000n;
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("ERC20ConfidentialLib zero-address receiver", function () {
  async function deployHarness(): Promise<ConfidentialHarness> {
    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const Harness = await ethers.getContractFactory("ConfidentialHarness", {
      libraries: { [LIB_FQN]: await lib.getAddress() },
    });
    const h = (await Harness.deploy()) as unknown as ConfidentialHarness;
    await h.waitForDeployment();
    await (await h.initialize(6)).wait(); // rate = 1
    return h;
  }

  // Seeds the pool with real backing, so a reverted call that leaves it unchanged is observable.
  async function seedPool(h: ConfidentialHarness): Promise<bigint> {
    const [, seeder] = await ethers.getSigners();
    await (await h.ledgerMintPublic(seeder.address, SEED)).wait();
    await (await h.connect(seeder).shield(SEED)).wait();
    return SEED;
  }

  it("confidentialMint to address(0) reverts and leaves the pool untouched", async function () {
    const h = await deployHarness();
    const pool = await h.CONFIDENTIAL_POOL();
    const before = await seedPool(h);

    await expect(h.mint(ZeroAddress, 1_000n))
      .to.be.revertedWithCustomError(h, "ConfidentialInvalidReceiver")
      .withArgs(ZeroAddress);
    expect(await h.balanceOf(pool)).to.equal(before);
    expect(await h.confidentialTotalSupplyPlaintext()).to.equal(before);
  });

  it("shieldTo address(0) reverts instead of minting unbacked public supply", async function () {
    const h = await deployHarness();
    const pool = await h.CONFIDENTIAL_POOL();
    const before = await seedPool(h);

    await expect(h.shieldToPublic(ZeroAddress, 1_000n))
      .to.be.revertedWithCustomError(h, "ConfidentialInvalidReceiver")
      .withArgs(ZeroAddress);
    expect(await h.balanceOf(pool)).to.equal(before);
    expect(await h.confidentialTotalSupplyPlaintext()).to.equal(before);
  });

  it("autoShield to address(0) is a no-op (best-effort, never reverts)", async function () {
    const h = await deployHarness();
    const pool = await h.CONFIDENTIAL_POOL();
    const policy = await ethers.deployContract("MockMintModePolicy");
    const before = await seedPool(h);

    const tx = h.autoShieldPublic(await policy.getAddress(), ZeroAddress, 1_000n);
    await expect(tx).to.not.be.reverted;
    await expect(tx).to.not.emit(h, "TokensShielded");
    expect(await h.balanceOf(pool)).to.equal(before);
  });

  it("CONTROL: shieldTo and autoShield to a real account still credit it", async function () {
    const [, alice, bob] = await ethers.getSigners();
    const h = await deployHarness();
    const pool = await h.CONFIDENTIAL_POOL();
    const policy = await ethers.deployContract("MockMintModePolicy");

    await (await h.ledgerMintPublic(alice.address, 1_000n)).wait();
    await (await h.shieldToPublic(alice.address, 1_000n)).wait();
    await hre.cofhe.mocks.expectPlaintext(await h.confidentialBalanceOf(alice.address), 1_000n);

    await (await h.ledgerMintPublic(bob.address, 500n)).wait();
    await (await h.autoShieldPublic(await policy.getAddress(), bob.address, 500n)).wait();
    await hre.cofhe.mocks.expectPlaintext(await h.confidentialBalanceOf(bob.address), 500n);

    expect(await h.balanceOf(pool)).to.equal(1_500n);
  });
});
