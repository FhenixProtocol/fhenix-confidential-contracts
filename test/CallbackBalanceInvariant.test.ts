import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { FHERC20_Harness, MockERC20Confidential, CallbackBalanceMover } from "../typechain-types";
import { prepExpectFHERC20BalancesChange, expectFHERC20BalancesChange } from "./utils";

// Consensys Diligence 5.16 — `_transferAndCall` / `_moveAndCall` credit the recipient, invoke its
// untrusted callback, then compensate with a refund on rejection. That refund is a saturating
// debit (`tryDecrease` returns the old value rather than reverting) against a balance the
// recipient controls, so a recipient that moved its balance mid-callback would refund nothing:
// `transferred = sub(sent, 0) = sent`, meaning it keeps the funds AND signals rejection.
//
// The sweep itself is already blocked — every confidentialTransfer*/unshield entry point is
// nonReentrant (see FHERC20Reentrancy.test.ts and ReentrancyExploit.test.ts). These tests lock
// in the LOCAL statement of that invariant: a balance-handle snapshot across the callback, which
// fires even when the move arrives through a path that never touched the reentrancy guard.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("callback balance invariant (Diligence 5.16)", function () {
  const AMOUNT = BigInt(1e6); // 1.0 confidential unit at 6 decimals

  async function mover(accept: boolean): Promise<CallbackBalanceMover> {
    const m = (await (await ethers.getContractFactory("CallbackBalanceMover")).deploy(accept)) as CallbackBalanceMover;
    await m.waitForDeployment();
    return m;
  }

  describe("FHERC20Core._transferAndCall", function () {
    async function fixture() {
      const [, bob] = await ethers.getSigners();
      const token = (await (
        await ethers.getContractFactory("FHERC20_Harness")
      ).deploy("Confidential Token", "CTK", 6, "")) as FHERC20_Harness;
      await token.waitForDeployment();
      await (await token.mint(bob.address, 10n * AMOUNT)).wait();
      const bobClient = await hre.cofhe.createClientWithBatteries(bob);
      return { bob, token, bobClient };
    }

    async function encrypted(token: FHERC20_Harness, client: any) {
      return client
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await token.getAddress())
        .execute();
    }

    it("reverts when the receiver burns its credit through an unguarded path", async function () {
      const { bob, token, bobClient } = await fixture();
      const evil = await mover(false);

      // FHERC20_Harness.burn is public and NOT nonReentrant — it stands in for a future
      // balance-moving entry point added without the guard. This is the 5.16 exploit: burn the
      // just-credited amount, then return false so the refund debits a balance that is gone.
      await evil.arm(
        token.target as string,
        token.interface.encodeFunctionData("burn", [await evil.getAddress(), AMOUNT]),
      );

      const [encInput, inputProof] = await encrypted(token, bobClient);

      await expect(
        token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
          ](await evil.getAddress(), encInput, inputProof, "0x"),
      ).to.be.revertedWithCustomError(token, "FHERC20ReceiverMovedBalance");
    });

    it("reverts on a mid-callback balance move even when the receiver accepts", async function () {
      const { bob, token, bobClient } = await fixture();
      const evil = await mover(true);

      // The check is unconditional: it cannot branch on `success`, which is encrypted. A receiver
      // that accepts has no business moving its balance inside the callback either.
      await evil.arm(
        token.target as string,
        token.interface.encodeFunctionData("burn", [await evil.getAddress(), AMOUNT]),
      );

      const [encInput, inputProof] = await encrypted(token, bobClient);

      await expect(
        token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
          ](await evil.getAddress(), encInput, inputProof, "0x"),
      ).to.be.revertedWithCustomError(token, "FHERC20ReceiverMovedBalance");
    });

    it("CONTROL: an unarmed receiver that rejects is still fully refunded", async function () {
      const { bob, token, bobClient } = await fixture();
      const benign = await mover(false);
      const addr = await benign.getAddress();

      const [encInput, inputProof] = await encrypted(token, bobClient);

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, addr);

      await token
        .connect(bob)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](addr, encInput, inputProof, "0x");

      // The refund path still works: nobody's balance moves. The tripwire is not over-eager.
      await expectFHERC20BalancesChange(token, bob.address, 0n);
      await expectFHERC20BalancesChange(token, addr, 0n);
    });

    it("CONTROL: an unarmed receiver that accepts still receives the transfer", async function () {
      const { bob, token, bobClient } = await fixture();
      const benign = await mover(true);
      const addr = await benign.getAddress();

      const [encInput, inputProof] = await encrypted(token, bobClient);

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, addr);

      await token
        .connect(bob)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](addr, encInput, inputProof, "0x");

      await expectFHERC20BalancesChange(token, bob.address, -1n * AMOUNT);
      await expectFHERC20BalancesChange(token, addr, AMOUNT);
    });
  });

  describe("ERC20ConfidentialLib._moveAndCall", function () {
    async function fixture() {
      const [, bob] = await ethers.getSigners();
      const lib = await ethers.deployContract(LIB_FQN);
      await lib.waitForDeployment();
      const token = (await (
        await ethers.getContractFactory("MockERC20Confidential", {
          libraries: { [LIB_FQN]: await lib.getAddress() },
        })
      ).deploy("Confidential Token", "CTK", 18)) as MockERC20Confidential;
      await token.waitForDeployment();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const bobClient = await hre.cofhe.createClientWithBatteries(bob);
      return { bob, token, bobClient };
    }

    it("reverts when the receiver burns its credit through an unguarded path", async function () {
      const { bob, token, bobClient } = await fixture();
      const evil = await mover(false);
      const addr = await evil.getAddress();

      // harnessConfidentialBurn is public and NOT nonReentrant — it stands in for a future
      // balance-moving entry point added without the guard. This is the 5.16 exploit: burn the
      // just-credited amount, then return false so the refund debits a balance that is gone.
      await evil.arm(
        token.target as string,
        token.interface.encodeFunctionData("harnessConfidentialBurn", [addr, AMOUNT]),
      );

      const [encInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await token.getAddress())
        .execute();

      await expect(
        token
          .connect(bob)
          ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](addr, encInput, inputProof, "0x"),
      ).to.be.revertedWithCustomError(token, "ConfidentialReceiverMovedBalance");
    });

    it("reverts on a mid-callback balance INCREASE too", async function () {
      const { bob, token, bobClient } = await fixture();
      const evil = await mover(false);
      const addr = await evil.getAddress();

      // An increase cannot enable the 5.16 theft — the refund would still succeed. The check
      // rejects it anyway, because distinguishing the direction would mean comparing ciphertexts
      // and an encrypted comparison cannot gate a revert. Pinning the blunt rule here so it is a
      // decision on record.
      await evil.arm(
        token.target as string,
        token.interface.encodeFunctionData("harnessConfidentialMint", [addr, AMOUNT]),
      );

      const [encInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await token.getAddress())
        .execute();

      await expect(
        token
          .connect(bob)
          ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](addr, encInput, inputProof, "0x"),
      ).to.be.revertedWithCustomError(token, "ConfidentialReceiverMovedBalance");
    });

    it("CONTROL: an unarmed receiver that rejects is still fully refunded", async function () {
      const { bob, token, bobClient } = await fixture();
      const benign = await mover(false);
      const addr = await benign.getAddress();

      const [encInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await token.getAddress())
        .execute();

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, addr);

      await token
        .connect(bob)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](addr, encInput, inputProof, "0x");

      await expectFHERC20BalancesChange(token, bob.address, 0n);
      await expectFHERC20BalancesChange(token, addr, 0n);
    });

    it("CONTROL: an unarmed receiver that accepts still receives the transfer", async function () {
      const { bob, token, bobClient } = await fixture();
      const benign = await mover(true);
      const addr = await benign.getAddress();

      const [encInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(AMOUNT)])
        .setConsumingContract(await token.getAddress())
        .execute();

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, addr);

      await token
        .connect(bob)
        ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](addr, encInput, inputProof, "0x");

      await expectFHERC20BalancesChange(token, bob.address, -1n * AMOUNT);
      await expectFHERC20BalancesChange(token, addr, AMOUNT);
    });
  });
});
