import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { FHERC20_Harness, MockFHERC20Receiver, UnsharedAnswerReceiver } from "../typechain-types";
import { prepExpectFHERC20BalancesChange, expectFHERC20BalancesChange } from "./utils";

// Consensys Diligence 5.30 — an IERC7984Receiver must ACL-grant its returned answer to the token,
// because every operand of an FHE operation is checked against the contract performing it. The
// finding was that this obligation was undocumented while all three receiver mocks obeyed it, so
// the test suite silently encoded a precondition the public interface omitted.
//
// The shared-handle migration resolved it: the boundary is `sharedEuint64` / `sharedEbool`, and
// IERC7984Receiver now states the obligation. These tests pin the CONSEQUENCE of skipping it, so
// the documented contract is enforced by the suite rather than only described in a comment.
describe("receiver ACL obligation (Diligence 5.30)", function () {
  const AMOUNT = BigInt(1e6);

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

  // Both directions: the obligation is not conditional on the answer.
  for (const accept of [true, false]) {
    it(`reverts when the receiver returns an unshared answer (accept=${accept})`, async function () {
      const { bob, token, bobClient } = await fixture();

      const receiver = (await (
        await ethers.getContractFactory("UnsharedAnswerReceiver")
      ).deploy(accept)) as UnsharedAnswerReceiver;
      await receiver.waitForDeployment();

      const [encInput, inputProof] = await encrypted(token, bobClient);

      // The token cannot use a handle it was never granted, so the transfer fails outright with
      // NotShared from the TaskManager. It must NOT degrade into "unusable answer == rejection",
      // which would hand an integrator a silent refund instead of an error naming the mistake.
      let message = "";
      try {
        await token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
          ](await receiver.getAddress(), encInput, inputProof, "0x");
      } catch (e: any) {
        message = e.message ?? "";
      }
      expect(message, "expected the unshared answer to be rejected").to.contain("NotShared");
    });
  }

  it("leaves the sender whole when an unshared answer reverts the transfer", async function () {
    const { bob, token, bobClient } = await fixture();

    const receiver = await (await ethers.getContractFactory("UnsharedAnswerReceiver")).deploy(true);
    await receiver.waitForDeployment();
    const [encInput, inputProof] = await encrypted(token, bobClient);

    await prepExpectFHERC20BalancesChange(token, bob.address);
    try {
      await token
        .connect(bob)
        [
          "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
        ](await receiver.getAddress(), encInput, inputProof, "0x");
    } catch {
      /* expected */
    }
    await expectFHERC20BalancesChange(token, bob.address, 0n);
  });

  it("CONTROL: a receiver that shares its answer correctly is accepted", async function () {
    const { bob, token, bobClient } = await fixture();

    // MockFHERC20Receiver returns FHE.shareEbool(retval, msg.sender) — the documented contract.
    const good = (await (await ethers.getContractFactory("MockFHERC20Receiver")).deploy()) as MockFHERC20Receiver;
    await good.waitForDeployment();
    const addr = await good.getAddress();
    const [encInput, inputProof] = await encrypted(token, bobClient);

    await prepExpectFHERC20BalancesChange(token, bob.address);
    await prepExpectFHERC20BalancesChange(token, addr);

    const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]); // accept
    await token
      .connect(bob)
      ["confidentialTransferAndCall(address,bytes32,bytes,bytes)"](addr, encInput, inputProof, callData);

    await expectFHERC20BalancesChange(token, bob.address, -1n * AMOUNT);
    await expectFHERC20BalancesChange(token, addr, AMOUNT);
  });
});
