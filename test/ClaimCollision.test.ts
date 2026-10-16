import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ConfidentialHarness } from "../typechain-types";

// Regression test for the unshield claim-key collision.
//
// CoFHE derives ciphertext handles deterministically from operation inputs with NO
// sender/nonce salt, so two accounts with identical balance-handle lineage (e.g. both
// fresh, both shield the same amount, then unshield the same amount) produce a
// byte-for-byte identical burned handle. When claims were keyed by that handle and
// written unconditionally, the second unshield OVERWROTE the first — reassigning `.to`
// and resetting `.claimed` — so a permissionless attacker could hijack a victim's
// pending claim and redirect their payout.
//
// The fix keys each claim by a unique per-claimant id (keccak256(to, nonce++, handle)),
// keeping the handle only as `ctHash` for the decrypt-proof binding. Colliding handles
// now produce distinct claim records that settle independently to their true owners.
//
// This exercises the Core + ERC20ConfidentialLib delegatecall path that production hosts use
// (via ConfidentialHarness).
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("unshield claim-key collision", function () {
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

  // The sole pending claim for `user` (this suite creates exactly one per account).
  async function onlyClaim(h: ConfidentialHarness, user: string) {
    const claims = await h.getUserClaims(user);
    expect(claims.length).to.equal(1);
    return claims[0];
  }

  it("CONTROL: a lone unshield creates a claim owned by the caller and pays out in full", async function () {
    const [, alice] = await ethers.getSigners();
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const h = await deployHarness();

    const C = 900_001n;
    const A = 300_001n;
    await (await h.ledgerMintPublic(alice.address, C)).wait();
    await (await h.connect(alice).shield(C)).wait();
    await (await h.connect(alice)["unshield(uint64)"](A)).wait();

    const claim = await onlyClaim(h, alice.address);
    expect(claim.to).to.equal(alice.address);
    expect(claim.claimed).to.equal(false);

    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    const dec = await aliceClient.decryptForTx(claim.ctHash).withoutACP().execute();
    await (await h.connect(alice).claimUnshielded(claim.id, dec.decryptedValue, dec.signature)).wait();

    expect(await h.ledger(alice.address)).to.equal(A); // rate 1 → A public paid to alice
  });

  it("an attacker's colliding unshield gets a distinct claim id and cannot hijack the victim's claim", async function () {
    const [, alice, bob] = await ethers.getSigners();
    const h = await deployHarness();

    const C = 700_003n;
    const A = 250_003n;

    // Victim unshields → pending claim owned by the victim.
    await (await h.ledgerMintPublic(alice.address, C)).wait();
    await (await h.connect(alice).shield(C)).wait();
    await (await h.connect(alice)["unshield(uint64)"](A)).wait();
    const aliceClaim = await onlyClaim(h, alice.address);
    expect(aliceClaim.to).to.equal(alice.address);

    // Attacker reproduces the identical lineage and unshields the same amount.
    await (await h.ledgerMintPublic(bob.address, C)).wait();
    await (await h.connect(bob).shield(C)).wait();
    await (await h.connect(bob)["unshield(uint64)"](A)).wait();
    const bobClaim = await onlyClaim(h, bob.address);

    // Collision precondition holds — the burned handles are byte-for-byte identical...
    expect(bobClaim.ctHash).to.equal(aliceClaim.ctHash);
    // ...yet the claims are DISTINCT records with different ids, and the victim's claim
    // is untouched: still owned by the victim, still unclaimed. (Before the fix, the
    // attacker's unshield overwrote this record's `.to` with its own address.)
    expect(bobClaim.id).to.not.equal(aliceClaim.id);
    const victimClaim = await h.getClaim(aliceClaim.id);
    expect(victimClaim.to).to.equal(alice.address);
    expect(victimClaim.claimed).to.equal(false);
  });

  it("colliding claims settle independently — each claimant is paid their own funds", async function () {
    const [, alice, bob] = await ethers.getSigners();
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const h = await deployHarness();

    const C = 600_004n;
    const A = 150_004n;

    await (await h.ledgerMintPublic(alice.address, C)).wait();
    await (await h.connect(alice).shield(C)).wait();
    await (await h.connect(alice)["unshield(uint64)"](A)).wait();
    const aliceClaim = await onlyClaim(h, alice.address);

    // Attacker mounts the collision (same burned handle, distinct claim id).
    await (await h.ledgerMintPublic(bob.address, C)).wait();
    await (await h.connect(bob).shield(C)).wait();
    await (await h.connect(bob)["unshield(uint64)"](A)).wait();
    const bobClaim = await onlyClaim(h, bob.address);
    expect(bobClaim.ctHash).to.equal(aliceClaim.ctHash);

    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");

    // Each claims their OWN id and is paid their OWN funds — no cross-theft, no stranding.
    const decA = await aliceClient.decryptForTx(aliceClaim.ctHash).withoutACP().execute();
    await (await h.connect(alice).claimUnshielded(aliceClaim.id, decA.decryptedValue, decA.signature)).wait();

    const decB = await bobClient.decryptForTx(bobClaim.ctHash).withoutACP().execute();
    await (await h.connect(bob).claimUnshielded(bobClaim.id, decB.decryptedValue, decB.signature)).wait();

    expect(await h.ledger(alice.address)).to.equal(A);
    expect(await h.ledger(bob.address)).to.equal(A);
  });
});
