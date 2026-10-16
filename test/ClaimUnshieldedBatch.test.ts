import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ConfidentialHarness } from "../typechain-types";

// Exercises the batch unshield-claim added to ERC20ConfidentialCoreUpgradeable, over the
// Core + ERC20ConfidentialLib delegatecall path (the same path production hosts use).
// The batch is a length-checked loop over the single-claim library function, so a passing
// batch confirms N pending claims settle atomically in one transaction.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("claimUnshieldedBatch", function () {
  async function deployHarness(): Promise<ConfidentialHarness> {
    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const Harness = await ethers.getContractFactory("ConfidentialHarness", {
      libraries: { [LIB_FQN]: await lib.getAddress() },
    });
    const h = (await Harness.deploy()) as unknown as ConfidentialHarness;
    await h.waitForDeployment();
    await (await h.initialize(6)).wait(); // 6 public / 6 confidential decimals → rate = 1 (1:1)
    return h;
  }

  it("settles multiple pending claims for a caller in a single call", async function () {
    const [, alice] = await ethers.getSigners();
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const h = await deployHarness();

    const C = 900_001n;
    const A1 = 100_003n;
    const A2 = 250_007n;

    await (await h.ledgerMintPublic(alice.address, C)).wait();
    await (await h.connect(alice).shield(C)).wait();
    // Two distinct unshields → two distinct pending claims.
    await (await h.connect(alice)["unshield(uint64)"](A1)).wait();
    await (await h.connect(alice)["unshield(uint64)"](A2)).wait();

    const claims = await h.getUserClaims(alice.address);
    expect(claims.length).to.equal(2);

    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");

    const ids: string[] = [];
    const amounts: bigint[] = [];
    const proofs: string[] = [];
    for (const claim of claims) {
      const dec = await aliceClient.decryptForTx(claim.ctHash).withoutACP().execute();
      ids.push(claim.id);
      amounts.push(dec.decryptedValue);
      proofs.push(dec.signature);
    }

    await (await h.connect(alice).claimUnshieldedBatch(ids, amounts, proofs)).wait();

    // Both claims paid out to alice (rate 1), and both records are now marked claimed.
    expect(await h.ledger(alice.address)).to.equal(A1 + A2);
    for (const id of ids) {
      expect((await h.getClaim(id)).claimed).to.equal(true);
    }
    expect((await h.getUserClaims(alice.address)).length).to.equal(0);
  });

  it("reverts on mismatched array lengths", async function () {
    const [, alice] = await ethers.getSigners();
    const h = await deployHarness();
    await expect(
      h.connect(alice).claimUnshieldedBatch(
        [ethers.ZeroHash],
        [1n, 2n], // length mismatch
        ["0x"],
      ),
    ).to.be.revertedWithCustomError(h, "ClaimBatchLengthMismatch");
  });
});
