import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { FHERC20NativeWrapper_Harness, WETH_Harness, ReentrancyProbeReceiver } from "../typechain-types";

// Consensys Diligence 5.31 — `unshield` and every `confidentialTransfer*` carried `nonReentrant`,
// but the shield and claim paths did not, despite making raw `call{value:}` / `safeTransfer`
// calls to attacker-influenced addresses. No drain existed: `handleClaim` marks a claim consumed
// before the payout, the batch marks all of them before its loop, and nothing derives an amount
// from `address(this).balance`. The asymmetry is the defect — those are properties of today's
// call graph, not invariants, and a later balance-derived computation would void them silently.
//
// The guard is now uniform. Proving it needs care: the wrapper pays with a raw `call{value:}` and
// converts any failure into `NativeTransferFailed`, so a reverting receiver would mask the reason.
// `ReentrancyProbeReceiver` therefore RECORDS the inner failure and lets the payout succeed, and
// these tests assert on the recorded selector.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

const REENTRANT_CALL = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
const CLAIM_NOT_FOUND = ethers.id("ClaimNotFound()").slice(0, 10);

describe("reentrancy guard uniformity (Diligence 5.31)", function () {
  async function fixture() {
    const [, bob] = await ethers.getSigners();

    const wETH = (await ethers.deployContract("WETH_Harness")) as WETH_Harness;
    await wETH.waitForDeployment();
    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const eETH = (await (
      await ethers.getContractFactory("FHERC20NativeWrapper_Harness", {
        libraries: { [LIB_FQN]: await lib.getAddress() },
      })
    ).deploy(wETH.target, "FHERC20 Wrapped ETH", "eETH", "u")) as FHERC20NativeWrapper_Harness;
    await eETH.waitForDeployment();

    const probe = (await ethers.deployContract("ReentrancyProbeReceiver")) as ReentrancyProbeReceiver;
    await probe.waitForDeployment();

    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    await eETH.connect(bob).shieldNative(bob, { value: ethers.parseEther("10") });

    return { bob, eETH, wETH, probe, bobClient };
  }

  // Creates a pending claim payable to `probe` and returns a valid proof for it.
  async function claimTo(f: Awaited<ReturnType<typeof fixture>>, to: string) {
    const tx = await f.eETH.connect(f.bob)["unshield(address,address,uint64)"](f.bob.address, to, 1_000_000n);
    const receipt = await tx.wait();
    let ctHash: string | undefined;
    for (const log of receipt!.logs) {
      try {
        const p = f.eETH.interface.parseLog({ topics: log.topics as string[], data: log.data });
        if (p?.name === "Unshielded") ctHash = p.args.amount;
      } catch {}
    }
    const claimId = (await f.eETH.getUserClaims(to)).filter(c => !c.claimed)[0].id;
    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    const proof = await f.bobClient.decryptForTx(ctHash!).withoutACP().execute();
    return { claimId, proof };
  }

  // Each case re-enters a DIFFERENT guarded entry point from the payout callback. The reentrant
  // call uses deliberately invalid arguments: `nonReentrant` runs before any argument handling,
  // so a guarded function fails with ReentrancyGuardReentrantCall while an unguarded one would
  // get as far as rejecting the arguments. That difference is the assertion.
  const vectors: { name: string; payload: (c: FHERC20NativeWrapper_Harness) => string }[] = [
    {
      name: "claimUnshielded",
      payload: c => c.interface.encodeFunctionData("claimUnshielded", [ethers.ZeroHash, 0n, "0x"]),
    },
    {
      name: "claimUnshieldedAsWETH",
      payload: c => c.interface.encodeFunctionData("claimUnshieldedAsWETH", [ethers.ZeroHash, 0n, "0x"]),
    },
    {
      name: "claimUnshieldedBatch",
      payload: c => c.interface.encodeFunctionData("claimUnshieldedBatch", [[], [], []]),
    },
    {
      name: "shieldWrappedNative",
      payload: c => c.interface.encodeFunctionData("shieldWrappedNative", [ethers.ZeroAddress, 0n]),
    },
  ];

  for (const v of vectors) {
    it(`blocks re-entry into ${v.name} from the claim payout`, async function () {
      const f = await fixture();
      const probeAddr = await f.probe.getAddress();
      const { claimId, proof } = await claimTo(f, probeAddr);

      await f.probe.arm(f.eETH.target as string, v.payload(f.eETH));

      // The payout itself succeeds — the probe swallows its own failed re-entry.
      await f.eETH.connect(f.bob).claimUnshielded(claimId, proof.decryptedValue, proof.signature);

      expect(await f.probe.fired()).to.equal(true);
      expect(await f.probe.lastSuccess()).to.equal(false);
      const data = await f.probe.lastReturnData();
      expect(data.slice(0, 10), `expected the guard to reject re-entry into ${v.name}`).to.equal(REENTRANT_CALL);
      expect(data.slice(0, 10)).to.not.equal(CLAIM_NOT_FOUND);
    });
  }

  it("blocks re-entry into shieldNative from the claim payout", async function () {
    const f = await fixture();
    const probeAddr = await f.probe.getAddress();
    const { claimId, proof } = await claimTo(f, probeAddr);

    // shieldNative is payable and would need value; the guard rejects it before that matters.
    await f.probe.arm(
      f.eETH.target as string,
      f.eETH.interface.encodeFunctionData("shieldNative", [ethers.ZeroAddress]),
    );

    await f.eETH.connect(f.bob).claimUnshielded(claimId, proof.decryptedValue, proof.signature);

    expect(await f.probe.lastSuccess()).to.equal(false);
    expect((await f.probe.lastReturnData()).slice(0, 10)).to.equal(REENTRANT_CALL);
  });

  it("CONTROL: an unarmed recipient is paid normally", async function () {
    const f = await fixture();
    const probeAddr = await f.probe.getAddress();
    const { claimId, proof } = await claimTo(f, probeAddr);

    const before = await ethers.provider.getBalance(probeAddr);
    await f.eETH.connect(f.bob).claimUnshielded(claimId, proof.decryptedValue, proof.signature);

    expect(await ethers.provider.getBalance(probeAddr)).to.be.greaterThan(before);
    expect((await f.eETH.getClaim(claimId)).claimed).to.equal(true);
  });

  it("CONTROL: the guards do not break sequential shield and claim calls", async function () {
    const f = await fixture();
    const [, , alice] = await ethers.getSigners();

    // Two shields and a claim in sequence: the guard is per-call, so back-to-back entry is fine.
    await f.eETH.connect(f.bob).shieldNative(f.bob, { value: ethers.parseEther("1") });
    await f.wETH.connect(f.bob).deposit({ value: ethers.parseEther("1") });
    await f.wETH.connect(f.bob).approve(f.eETH.target, ethers.parseEther("1"));
    await f.eETH.connect(f.bob).shieldWrappedNative(f.bob, ethers.parseEther("1"));

    const { claimId, proof } = await claimTo(f, alice.address);
    await expect(f.eETH.connect(f.bob).claimUnshielded(claimId, proof.decryptedValue, proof.signature)).to.emit(
      f.eETH,
      "ClaimedUnshielded",
    );
  });

  // The two paths the new guards could have DEADLOCKED, neither of which had coverage before:
  // the ERC-1363 receiver hook, and an override that reaches a now-guarded parent via `super`.
  describe("paths the guards must not deadlock", function () {
    it("still shields through the ERC-1363 onTransferReceived hook", async function () {
      const [, bob] = await ethers.getSigners();

      const wBTC = await ethers.deployContract("ERC20_Harness", ["Wrapped BTC", "wBTC", 8]);
      await wBTC.waitForDeployment();
      const lib = await ethers.deployContract(LIB_FQN);
      await lib.waitForDeployment();
      const eBTC = await (
        await ethers.getContractFactory("FHERC20ERC20Wrapper_Harness", {
          libraries: { [LIB_FQN]: await lib.getAddress() },
        })
      ).deploy(wBTC.target, "FHERC20 Wrapped BTC", "eBTC", "u");
      await eBTC.waitForDeployment();

      // onTransferReceived is now nonReentrant, and it is invoked BY the underlying token. Drive
      // it as the underlying to confirm the guard did not close the hook: it must still mint.
      const underlying = await wBTC.getAddress();
      await wBTC.mint(await eBTC.getAddress(), 100_000_000n);
      await hre.network.provider.send("hardhat_impersonateAccount", [underlying]);
      await hre.network.provider.send("hardhat_setBalance", [underlying, "0xde0b6b3a7640000"]);
      const asUnderlying = await ethers.getSigner(underlying);

      await expect(eBTC.connect(asUnderlying).onTransferReceived(bob.address, bob.address, 100_000_000n, "0x")).to.emit(
        eBTC,
        "ConfidentialTransfer",
      );

      await hre.network.provider.send("hardhat_stopImpersonatingAccount", [underlying]);
    });
  });
});
