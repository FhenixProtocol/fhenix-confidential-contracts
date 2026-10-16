import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import {
  FHERC20_Harness,
  FHERC20ERC20Wrapper_Harness,
  ERC20_Harness,
  MaliciousReentrantReceiver,
  MaliciousUnshieldReceiver,
  MockFHERC20Receiver,
} from "../typechain-types";
import { prepExpectFHERC20BalancesChange, expectFHERC20BalancesChange } from "./utils";

// Regression for grok-audit-1 Finding 1: cross-function reentrancy in the FHERC20
// `*AndCall` reject→refund path. `_transferAndCall` credits the recipient, invokes
// its untrusted callback, then (on `false`) runs a saturating refund. Without a
// reentrancy guard a malicious recipient can drain its just-credited balance during
// the callback — via `confidentialTransfer` (base) or `unshield` (wrapper) — then
// return `false`; the refund's `tryDecrease` finds a zero balance and no-ops, so the
// sender is debited and the attacker keeps the funds.
//
// The sibling ERC20ConfidentialCoreUpgradeable already guards this (see
// ReentrancyExploit.test.ts). These tests lock the same guard onto the FHERC20 family.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("FHERC20 *AndCall reentrancy (grok-audit-1 #1)", function () {
  const AMOUNT = BigInt(1e6); // 1.0 confidential unit at 6 decimals

  describe("base FHERC20 — confidentialTransfer sweep", function () {
    async function fixture() {
      const [, bob, attacker] = await ethers.getSigners();
      // FHERC20 base does not use the claims lib — no linking needed.
      const Factory = await ethers.getContractFactory("FHERC20_Harness");
      const token = (await Factory.deploy("Confidential Token", "CTK", 6, "")) as FHERC20_Harness;
      await token.waitForDeployment();
      await (await token.mint(bob.address, 10n * AMOUNT)).wait();
      const bobClient = await hre.cofhe.createClientWithBatteries(bob);
      return { bob, attacker, token, bobClient };
    }

    it("CONTROL: a benign receiver returning false is fully refunded (no balance moves)", async function () {
      const { bob, token, bobClient } = await fixture();
      const benign = (await (await ethers.getContractFactory("MockFHERC20Receiver")).deploy()) as MockFHERC20Receiver;
      const benignAddr = await benign.getAddress();

      const [encInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await token.getAddress())
        .execute();
      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, benignAddr);

      // data = 0 -> receiver returns false (reject), expecting the refund to hold.
      const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);
      await token
        .connect(bob)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](benignAddr, encInput, inputProof, callData);

      await expectFHERC20BalancesChange(token, bob.address, 0n);
      await expectFHERC20BalancesChange(token, benignAddr, 0n);
    });

    it("a reentrant receiver sweeping via confidentialTransfer must NOT keep the funds", async function () {
      const { bob, attacker, token, bobClient } = await fixture();
      const evil = (await (
        await ethers.getContractFactory("MaliciousReentrantReceiver")
      ).deploy(attacker.address)) as MaliciousReentrantReceiver;
      const evilAddr = await evil.getAddress();

      const [encInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await token.getAddress())
        .execute();
      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, attacker.address);

      // The guard makes the re-entrant confidentialTransfer revert, which bubbles up
      // and reverts the whole AndCall.
      await expect(
        token
          .connect(bob)
          ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](evilAddr, encInput, inputProof, "0x"),
      ).to.be.reverted;

      // Invariant regardless of how the fix is implemented: no theft.
      await expectFHERC20BalancesChange(token, attacker.address, 0n);
      await expectFHERC20BalancesChange(token, bob.address, 0n);
    });
  });

  describe("ERC20 wrapper — unshield-into-claim sweep", function () {
    async function fixture() {
      const [, bob, attacker] = await ethers.getSigners();
      const underlying = (await (
        await ethers.getContractFactory("ERC20_Harness")
      ).deploy("USD Coin", "USDC", 6)) as ERC20_Harness; // 6 decimals -> wrapper rate 1

      const lib = await ethers.deployContract(LIB_FQN);
      await lib.waitForDeployment();
      const Factory = await ethers.getContractFactory("FHERC20ERC20Wrapper_Harness", {
        libraries: { [LIB_FQN]: await lib.getAddress() },
      });
      const wrapper = (await Factory.deploy(
        underlying.target,
        "Confidential USDC",
        "eUSDC",
        "",
      )) as FHERC20ERC20Wrapper_Harness;
      await wrapper.waitForDeployment();

      // Fund bob and shield 10 units so he can transfer-and-call.
      await (await underlying.mint(bob.address, 10n * AMOUNT)).wait();
      await (await underlying.connect(bob).approve(wrapper.target, 10n * AMOUNT)).wait();
      await (await wrapper.connect(bob).shield(bob.address, 10n * AMOUNT)).wait();

      const bobClient = await hre.cofhe.createClientWithBatteries(bob);
      return { bob, attacker, wrapper, bobClient };
    }

    it("a reentrant receiver burning its credit via unshield must be blocked", async function () {
      const { bob, attacker, wrapper, bobClient } = await fixture();
      const evil = (await (
        await ethers.getContractFactory("MaliciousUnshieldReceiver")
      ).deploy(attacker.address)) as MaliciousUnshieldReceiver;
      const evilAddr = await evil.getAddress();

      const [encInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await wrapper.getAddress())
        .execute();
      await prepExpectFHERC20BalancesChange(wrapper, bob.address);

      // The guard on unshield makes the re-entrant call revert -> whole AndCall reverts.
      await expect(
        wrapper
          .connect(bob)
          ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](evilAddr, encInput, inputProof, "0x"),
      ).to.be.reverted;

      // Sender not debited, and the attacker never obtained a pending claim on the underlying.
      await expectFHERC20BalancesChange(wrapper, bob.address, 0n);
      const attackerClaims = await wrapper.getUserClaims(attacker.address);
      expect(attackerClaims.filter((c: { claimed: boolean }) => !c.claimed).length).to.equal(0);
    });
  });
});
