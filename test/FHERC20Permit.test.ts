import { expect } from "chai";
import { ethers } from "hardhat";
import hre from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { generateTransferFromPermit } from "./utils";
import { FHERC20Permit_Harness } from "../typechain-types";

describe("FHERC20Permit", function () {
  const setupFixture = async () => {
    const [owner, bob, alice, eve] = await ethers.getSigners();

    const XFHEFactory = await ethers.getContractFactory("FHERC20Permit_Harness");
    const XFHE = (await XFHEFactory.deploy("Unknown FHERC20", "XFHE", 18)) as FHERC20Permit_Harness;
    await XFHE.waitForDeployment();

    // Initialize CoFHE
    const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const eveClient = await hre.cofhe.createClientWithBatteries(eve);

    return { ownerClient, bobClient, aliceClient, eveClient, owner, bob, alice, eve, XFHE };
  };

  describe("permit", function () {
    it("Should accept owner signature and set operator", async function () {
      const { XFHE, bob, alice } = await loadFixture(setupFixture);

      const currentBlock = await ethers.provider.getBlock("latest");
      const until = currentBlock!.timestamp + 3600;

      const permit = await generateTransferFromPermit({
        token: XFHE,
        signer: bob,
        owner: bob.address,
        spender: alice.address,
        until,
      });

      await XFHE.permit(permit.owner, permit.spender, permit.until, permit.deadline, permit.v, permit.r, permit.s);

      expect(await XFHE.nonces(bob.address)).to.equal(1n);
      expect(await XFHE.isOperator(bob.address, alice.address)).to.equal(true);
    });

    it("Should reject reused signature", async function () {
      const { XFHE, bob, alice } = await loadFixture(setupFixture);

      const currentBlock = await ethers.provider.getBlock("latest");
      const until = currentBlock!.timestamp + 3600;

      const permit = await generateTransferFromPermit({
        token: XFHE,
        signer: bob,
        owner: bob.address,
        spender: alice.address,
        until,
      });

      // Use permit once
      await XFHE.permit(permit.owner, permit.spender, permit.until, permit.deadline, permit.v, permit.r, permit.s);

      // Try to reuse same signature
      await expect(
        XFHE.permit(permit.owner, permit.spender, permit.until, permit.deadline, permit.v, permit.r, permit.s),
      ).to.be.revertedWithCustomError(XFHE, "ERC2612InvalidSigner");
    });

    it("Should reject signature from different signer", async function () {
      const { XFHE, bob, alice, eve } = await loadFixture(setupFixture);

      const currentBlock = await ethers.provider.getBlock("latest");
      const until = currentBlock!.timestamp + 3600;

      // Sign with eve instead of bob
      const permit = await generateTransferFromPermit({
        token: XFHE,
        signer: eve,
        owner: bob.address,
        spender: alice.address,
        until,
      });

      await expect(
        XFHE.permit(permit.owner, permit.spender, permit.until, permit.deadline, permit.v, permit.r, permit.s),
      )
        .to.be.revertedWithCustomError(XFHE, "ERC2612InvalidSigner")
        .withArgs(eve.address, bob.address);
    });

    it("Should reject expired permit", async function () {
      const { XFHE, bob, alice } = await loadFixture(setupFixture);

      const currentBlock = await ethers.provider.getBlock("latest");
      const until = currentBlock!.timestamp + 3600;
      const deadline = BigInt(currentBlock!.timestamp - 3600); // Expired deadline

      const permit = await generateTransferFromPermit({
        token: XFHE,
        signer: bob,
        owner: bob.address,
        spender: alice.address,
        until,
        deadline,
      });

      await expect(
        XFHE.permit(permit.owner, permit.spender, permit.until, permit.deadline, permit.v, permit.r, permit.s),
      )
        .to.be.revertedWithCustomError(XFHE, "ERC2612ExpiredSignature")
        .withArgs(deadline);
    });

    it("Should allow operator to transfer after permit", async function () {
      const { XFHE, bob, alice, aliceClient } = await loadFixture(setupFixture);

      // Mint tokens to bob
      const mintValue = ethers.parseEther("10");
      await XFHE.mint(bob.address, mintValue);

      const currentBlock = await ethers.provider.getBlock("latest");
      const until = currentBlock!.timestamp + 3600;

      const permit = await generateTransferFromPermit({
        token: XFHE,
        signer: bob,
        owner: bob.address,
        spender: alice.address,
        until,
      });

      // Set alice as operator via permit
      await XFHE.permit(permit.owner, permit.spender, permit.until, permit.deadline, permit.v, permit.r, permit.s);

      // Encrypt transfer value
      const transferValue = ethers.parseEther("1");
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      // Alice should be able to transfer from bob
      await expect(
        XFHE.connect(alice)["confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"](
          bob.address,
          alice.address,
          encTransferInput,
        ),
      ).to.emit(XFHE, "Transfer");
    });

    it("Should increment nonce with each permit", async function () {
      const { XFHE, bob, alice, eve } = await loadFixture(setupFixture);

      const currentBlock = await ethers.provider.getBlock("latest");
      const until = currentBlock!.timestamp + 3600;

      expect(await XFHE.nonces(bob.address)).to.equal(0n);

      // First permit
      const permit1 = await generateTransferFromPermit({
        token: XFHE,
        signer: bob,
        owner: bob.address,
        spender: alice.address,
        until,
      });

      await XFHE.permit(
        permit1.owner,
        permit1.spender,
        permit1.until,
        permit1.deadline,
        permit1.v,
        permit1.r,
        permit1.s,
      );
      expect(await XFHE.nonces(bob.address)).to.equal(1n);

      // Second permit
      const permit2 = await generateTransferFromPermit({
        token: XFHE,
        signer: bob,
        owner: bob.address,
        spender: eve.address,
        until,
      });

      await XFHE.permit(
        permit2.owner,
        permit2.spender,
        permit2.until,
        permit2.deadline,
        permit2.v,
        permit2.r,
        permit2.s,
      );
      expect(await XFHE.nonces(bob.address)).to.equal(2n);
    });
  });
});
