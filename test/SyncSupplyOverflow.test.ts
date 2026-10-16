import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ConfidentialHarness } from "../typechain-types";

// Regression test for audit run-3 Finding 9 (Low).
//
// `syncConfidentialTotalSupply` used a hard `SafeCast.toUint64(balanceOf(POOL)/rate)` that
// REVERTS on overflow. Because the sync runs inside shield / claimUnshielded / confidentialMint,
// and CONFIDENTIAL_POOL is a plain address whose PUBLIC balance anyone can inflate with a direct
// token transfer ("donation"), a large enough donation could brick shield/mint and — since the
// claim leg syncs AFTER draining the pool — permanently deadlock claims, stranding already-burned
// funds.
//
// The fix SATURATES the plaintext at type(uint64).max instead of reverting. These cases exercise
// the real Core + ERC20ConfidentialLib delegatecall path every confidential host uses (via ConfidentialHarness):
// each is RED before the fix (SafeCastOverflowedUintDowncast) and GREEN after.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";
const U64_MAX = 2n ** 64n - 1n;

describe("syncConfidentialTotalSupply pool-donation overflow (audit run-3 F9)", function () {
  async function deployHarness(): Promise<ConfidentialHarness> {
    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const Harness = await ethers.getContractFactory("ConfidentialHarness", {
      libraries: { [LIB_FQN]: await lib.getAddress() },
    });
    const h = (await Harness.deploy()) as unknown as ConfidentialHarness;
    await h.waitForDeployment();
    await (await h.initialize(6)).wait(); // 6 public / 6 confidential decimals → rate = 1
    return h;
  }

  it("CONTROL: a sub-ceiling supply reads exactly after a shield", async function () {
    const [, alice] = await ethers.getSigners();
    const h = await deployHarness();
    await (await h.ledgerMintPublic(alice.address, 1_000_000n)).wait();
    await (await h.connect(alice).shield(1_000_000n)).wait();
    await hre.cofhe.mocks.expectPlaintext(await h.confidentialTotalSupply(), 1_000_000n);
  });

  it("a pool donation over the uint64 ceiling does NOT brick shield; the supply handle saturates", async function () {
    const [, alice] = await ethers.getSigners();
    const h = await deployHarness();
    const pool = await h.CONFIDENTIAL_POOL();

    // Donation: inflate the pool's public balance past type(uint64).max (rate = 1).
    await (await h.ledgerMintPublic(pool, U64_MAX + 1n)).wait();

    // shield runs syncConfidentialTotalSupply — before the fix this reverted (SafeCast overflow).
    await (await h.ledgerMintPublic(alice.address, 1_000_000n)).wait();
    await expect(h.connect(alice).shield(1_000_000n)).to.not.be.reverted;

    // The informational ciphertext saturates at uint64.max instead of reverting...
    await hre.cofhe.mocks.expectPlaintext(await h.confidentialTotalSupply(), U64_MAX);
    // ...while the exact uint256 view twin still reports the true (unclamped) figure.
    expect(await h.confidentialTotalSupplyPlaintext()).to.equal(U64_MAX + 1n + 1_000_000n);
  });

  it("a pool donation over the ceiling does NOT deadlock claims (burned funds stay claimable)", async function () {
    const [, alice] = await ethers.getSigners();
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const h = await deployHarness();
    const pool = await h.CONFIDENTIAL_POOL();

    const A = 300_001n;
    await (await h.ledgerMintPublic(alice.address, A)).wait();
    await (await h.connect(alice).shield(A)).wait();
    await (await h.connect(alice)["unshield(uint64)"](A)).wait();
    const [claim] = await h.getUserClaims(alice.address);

    // Donate over the ceiling AFTER the claim exists. The claim's post-drain sync would revert
    // (permanent deadlock) before the fix; the burned A would be stranded forever.
    await (await h.ledgerMintPublic(pool, U64_MAX + 1n)).wait();

    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    const dec = await aliceClient.decryptForTx(claim.ctHash).withoutACP().execute();
    await expect(h.connect(alice).claimUnshielded(claim.id, dec.decryptedValue, dec.signature)).to.not.be.reverted;

    // Alice is paid back the A she burned (rate 1), despite the over-ceiling pool balance.
    expect(await h.ledger(alice.address)).to.equal(A);
  });
});
