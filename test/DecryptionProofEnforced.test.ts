import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { FHERC20NativeWrapper_Harness, WETH_Harness } from "../typechain-types";

// Consensys Diligence 5.32 — two call sites verified a threshold-decryption proof and then threw
// the result away: ERC20ConfidentialLib.handleClaim (which gates a claim payout) and
// FHERC20Core.discloseEncryptedAmount. Both were safe at the audited commit, but only because the
// non-`Safe` FHE overload's TaskManager path reverts internally on a bad proof — a property of the
// callee, not something either call site enforced.
//
// Both now call `verifyDecryptResultSafe`, which reports a bad proof by returning false, and
// revert `InvalidDecryptionProof` themselves. That is what these tests pin: the token's OWN error
// on every rejection path, which is only reachable because the call site is now the thing doing
// the enforcing. Under the old code these same assertions would have seen a TaskManager-internal
// `InvalidSignature()` / `InvalidSigner(...)` instead.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("decryption proof enforcement (Diligence 5.32)", function () {
  // A pending claim plus a VALID proof for its burned handle. Every test below starts from a state
  // that would settle successfully, so a revert can only come from proof enforcement.
  async function pendingClaimFixture() {
    const [, bob, alice] = await ethers.getSigners();

    const wETH = (await ethers.deployContract("WETH_Harness")) as WETH_Harness;
    await wETH.waitForDeployment();
    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const factory = await ethers.getContractFactory("FHERC20NativeWrapper_Harness", {
      libraries: { [LIB_FQN]: await lib.getAddress() },
    });
    const eETH = (await factory.deploy(
      wETH.target,
      "FHERC20 Wrapped ETH",
      "eETH",
      "https://example.com/eeth.json",
    )) as FHERC20NativeWrapper_Harness;
    await eETH.waitForDeployment();

    const bobClient = await hre.cofhe.createClientWithBatteries(bob);

    await eETH.connect(bob).shieldNative(bob, { value: ethers.parseEther("10") });
    const tx = await eETH.connect(bob)["unshield(address,address,uint64)"](bob.address, alice.address, 1_000_000n);

    const receipt = await tx.wait();
    let ctHash: string | undefined;
    for (const log of receipt!.logs) {
      try {
        const parsed = eETH.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (parsed?.name === "Unshielded") ctHash = parsed.args.amount;
      } catch {}
    }
    if (ctHash === undefined) throw new Error("Unshielded event not found");

    const claimId = (await eETH.getUserClaims(alice.address))[0].id;

    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    const proof = await bobClient.decryptForTx(ctHash).withoutACP().execute();

    return { bob, alice, eETH, ctHash, claimId, proof };
  }

  const GARBAGE_SIG = "0x" + "11".repeat(65);

  describe("ERC20ConfidentialLib.handleClaim — gates a claim payout", function () {
    it("rejects a garbage signature", async function () {
      const { bob, eETH, claimId, proof } = await pendingClaimFixture();
      await expect(
        eETH.connect(bob).claimUnshielded(claimId, proof.decryptedValue, GARBAGE_SIG),
      ).to.be.revertedWithCustomError(eETH, "InvalidDecryptionProof");
    });

    it("rejects a valid signature over a different amount", async function () {
      const { bob, eETH, claimId, proof } = await pendingClaimFixture();
      await expect(eETH.connect(bob).claimUnshielded(claimId, 999_999n, proof.signature)).to.be.revertedWithCustomError(
        eETH,
        "InvalidDecryptionProof",
      );
    });

    it("leaves the claim pending and unpaid after a rejected proof", async function () {
      const { bob, alice, eETH, claimId, proof } = await pendingClaimFixture();
      const balanceBefore = await ethers.provider.getBalance(alice.address);

      await expect(
        eETH.connect(bob).claimUnshielded(claimId, proof.decryptedValue, GARBAGE_SIG),
      ).to.be.revertedWithCustomError(eETH, "InvalidDecryptionProof");

      expect((await eETH.getClaim(claimId)).claimed).to.equal(false);
      expect((await eETH.getUserClaims(alice.address)).length).to.equal(1);
      expect(await ethers.provider.getBalance(alice.address)).to.equal(balanceBefore);
    });

    it("CONTROL: a valid proof still settles the claim", async function () {
      const { bob, alice, eETH, claimId, proof } = await pendingClaimFixture();
      const balanceBefore = await ethers.provider.getBalance(alice.address);

      await expect(eETH.connect(bob).claimUnshielded(claimId, proof.decryptedValue, proof.signature)).to.emit(
        eETH,
        "ClaimedUnshielded",
      );

      expect((await eETH.getClaim(claimId)).claimed).to.equal(true);
      expect(await ethers.provider.getBalance(alice.address)).to.be.greaterThan(balanceBefore);
    });
  });

  describe("FHERC20Core.discloseEncryptedAmount", function () {
    it("rejects a garbage signature", async function () {
      const { bob, eETH, ctHash, proof } = await pendingClaimFixture();
      await expect(
        eETH.connect(bob).discloseEncryptedAmount(ctHash, proof.decryptedValue, GARBAGE_SIG),
      ).to.be.revertedWithCustomError(eETH, "InvalidDecryptionProof");
    });

    it("rejects a valid signature over a different amount", async function () {
      const { bob, eETH, ctHash, proof } = await pendingClaimFixture();
      await expect(
        eETH.connect(bob).discloseEncryptedAmount(ctHash, 12_345n, proof.signature),
      ).to.be.revertedWithCustomError(eETH, "InvalidDecryptionProof");
    });

    it("CONTROL: a valid proof still discloses the amount", async function () {
      const { bob, eETH, ctHash, proof } = await pendingClaimFixture();

      await expect(eETH.connect(bob).discloseEncryptedAmount(ctHash, proof.decryptedValue, proof.signature))
        .to.emit(eETH, "AmountDisclosed")
        .withArgs(ctHash, proof.decryptedValue);
    });
  });
});
