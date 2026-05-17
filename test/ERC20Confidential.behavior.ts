import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  MockERC20Confidential,
  ERC20ConfidentialUpgradeable_Harness,
  ERC20ConfidentialIndicator,
  MockFHERC20Receiver,
} from "../typechain-types";
import { CofheClient, Encryptable } from "@cofhe/sdk";
import { ContractTransactionResponse, ZeroAddress } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  prepExpectERC20BalancesChange,
  expectERC20BalancesChange,
  prepExpectFHERC20BalancesChange,
  expectFHERC20BalancesChange,
} from "./utils";

type ERC20ConfidentialToken = MockERC20Confidential | ERC20ConfidentialUpgradeable_Harness;

export interface SetupFixtureResult {
  token: ERC20ConfidentialToken;
  indicator: ERC20ConfidentialIndicator;
  owner: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  ownerClient: CofheClient;
  bobClient: CofheClient;
  aliceClient: CofheClient;
}

type SetupFixtureFn = () => Promise<SetupFixtureResult>;
type DeployWithDecimalsFn = (decimals: number) => Promise<ERC20ConfidentialToken>;

async function getUnshieldRequestId(
  tx: ContractTransactionResponse,
  contract: ERC20ConfidentialToken,
): Promise<string> {
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "TokensUnshielded") {
        return parsed.args.amount;
      }
    } catch {}
  }
  throw new Error("TokensUnshielded event not found");
}

export function shouldBehaveLikeERC20Confidential(
  setupFixture: SetupFixtureFn,
  deployWithDecimals: DeployWithDecimalsFn,
) {
  describe("Initialization", function () {
    it("Should be constructed correctly", async function () {
      const { token, indicator } = await setupFixture();

      expect(await token.name()).to.equal("Confidential Token");
      expect(await token.symbol()).to.equal("CTK");
      expect(await token.decimals()).to.equal(18);
      expect(await token.confidentialDecimals()).to.equal(6);

      expect(await indicator.name()).to.equal("1011000 Confidential Token");
      expect(await indicator.symbol()).to.equal("cCTK");
      expect(await indicator.decimals()).to.equal(4);
    });
  });

  describe("Shielding (Public -> Confidential)", function () {
    it("Should shield tokens correctly", async function () {
      const { token, indicator, bob } = await setupFixture();

      const mintAmount = ethers.parseEther("100");
      await token.mint(bob.address, mintAmount);

      expect(await token.balanceOf(bob.address)).to.equal(mintAmount);

      const shieldAmount = ethers.parseEther("10");
      const expectedConfidentialAmount = BigInt(10 * 1e6);

      await prepExpectERC20BalancesChange(token, bob.address);

      await expect(token.connect(bob).shield(shieldAmount))
        .to.emit(token, "TokensShielded")
        .withArgs(bob.address, shieldAmount);

      await expectERC20BalancesChange(token, bob.address, -1n * shieldAmount);

      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, expectedConfidentialAmount);

      expect(await indicator.balanceOf(bob.address)).to.equal(10110005001n);
    });

    it("Should fail to shield amounts too small for confidential precision", async function () {
      const { token, bob } = await setupFixture();

      const dustAmount = BigInt(1e11);
      await token.mint(bob.address, ethers.parseEther("1"));

      await expect(token.connect(bob).shield(dustAmount)).to.be.revertedWithCustomError(
        token,
        "AmountTooSmallForConfidentialPrecision",
      );
    });
  });

  describe("Unshielding (Confidential -> Public)", function () {
    it("Should unshield tokens correctly", async function () {
      const { token, bob, bobClient } = await setupFixture();

      const initialAmount = ethers.parseEther("100");
      await token.mint(bob.address, initialAmount);
      await token.connect(bob).shield(initialAmount);

      const unshieldAmountConfidential = BigInt(50 * 1e6);
      const unshieldAmountPublic = ethers.parseEther("50");

      const tx = await token.connect(bob)["unshield(uint64)"](unshieldAmountConfidential);
      await expect(tx).to.emit(token, "TokensUnshielded");

      const unshieldRequestId = await getUnshieldRequestId(tx, token);

      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, BigInt(50 * 1e6));

      expect(await token.balanceOf(bob.address)).to.equal(0);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(unshieldRequestId).withoutPermit().execute();

      await expect(
        token.connect(bob).claimUnshielded(unshieldRequestId, decryption.decryptedValue, decryption.signature),
      ).to.emit(token, "UnshieldedTokensClaimed");

      expect(await token.balanceOf(bob.address)).to.equal(unshieldAmountPublic);
    });

    it("Should unshield using an encrypted (euint64) amount", async function () {
      const { token, bob, bobClient } = await setupFixture();

      const initialAmount = ethers.parseEther("100");
      await token.mint(bob.address, initialAmount);
      await token.connect(bob).shield(initialAmount);

      // Use bob's full encrypted balance handle as the euint64 input.
      // Bob has ACL access to it because _confidentialUpdate calls FHE.allow(ptr, from).
      const encryptedAmount = await token.confidentialBalanceOf(bob.address);

      const tx = await token.connect(bob)["unshield(bytes32)"](encryptedAmount);
      await expect(tx).to.emit(token, "TokensUnshielded");

      const unshieldRequestId = await getUnshieldRequestId(tx, token);

      // Claim is recorded with requestedAmount = 0 (cleartext unknown until decryption proof).
      const pendingClaim = await token.getClaim(unshieldRequestId);
      expect(pendingClaim.to).to.equal(bob.address);
      expect(pendingClaim.requestedAmount).to.equal(0n);
      expect(pendingClaim.claimed).to.equal(false);

      // Confidential balance is now zero.
      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, 0n);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(unshieldRequestId).withoutPermit().execute();

      await expect(
        token.connect(bob).claimUnshielded(unshieldRequestId, decryption.decryptedValue, decryption.signature),
      ).to.emit(token, "UnshieldedTokensClaimed");

      // Full original public amount is returned.
      expect(await token.balanceOf(bob.address)).to.equal(initialAmount);

      const claimsAfter = await token.getUserClaims(bob.address);
      expect(claimsAfter.length).to.equal(0);
    });

    it("Should revert encrypted unshield when caller has no ACL access to the amount", async function () {
      const { token, bob, alice } = await setupFixture();

      // Bob shields, so bob's balance handle is allowed for bob — not for alice.
      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const bobBalanceHandle = await token.confidentialBalanceOf(bob.address);

      await expect(token.connect(alice)["unshield(bytes32)"](bobBalanceHandle)).to.be.revertedWithCustomError(
        token,
        "ERC20ConfidentialUnauthorizedUseOfEncryptedAmount",
      );
    });

    it("Should support multiple concurrent unshield claims", async function () {
      const { token, bob, bobClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const tx1 = await token.connect(bob)["unshield(uint64)"](BigInt(3 * 1e6));
      const requestId1 = await getUnshieldRequestId(tx1, token);

      const tx2 = await token.connect(bob)["unshield(uint64)"](BigInt(2 * 1e6));
      const requestId2 = await getUnshieldRequestId(tx2, token);

      const pendingClaims = await token.getUserClaims(bob.address);
      expect(pendingClaims.length).to.equal(2);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const dec1 = await bobClient.decryptForTx(requestId1).withoutPermit().execute();
      const dec2 = await bobClient.decryptForTx(requestId2).withoutPermit().execute();

      await token.connect(bob).claimUnshielded(requestId1, dec1.decryptedValue, dec1.signature);
      await token.connect(bob).claimUnshielded(requestId2, dec2.decryptedValue, dec2.signature);

      expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther("5"));

      const claimsAfter = await token.getUserClaims(bob.address);
      expect(claimsAfter.length).to.equal(0);
    });
  });

  describe("Confidential Total Supply", function () {
    it("Should be the zero handle initially", async function () {
      const { token } = await setupFixture();
      expect(await token.confidentialTotalSupply()).to.equal(ethers.ZeroHash);
    });

    it("Should equal the shielded amount after a single shield", async function () {
      const { token, bob } = await setupFixture();

      const shieldAmount = ethers.parseEther("10");
      await token.mint(bob.address, shieldAmount);
      await token.connect(bob).shield(shieldAmount);

      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(10 * 1e6));
    });

    it("Should accumulate across shields by different users", async function () {
      const { token, bob, alice } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.mint(alice.address, ethers.parseEther("5"));

      await token.connect(bob).shield(ethers.parseEther("10"));
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(10 * 1e6));

      await token.connect(alice).shield(ethers.parseEther("5"));
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(15 * 1e6));
    });

    it("Should be unchanged by unshield until the claim settles", async function () {
      const { token, bob, bobClient } = await setupFixture();

      const initialAmount = ethers.parseEther("100");
      await token.mint(bob.address, initialAmount);
      await token.connect(bob).shield(initialAmount);

      const supplyBefore = BigInt(100 * 1e6);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), supplyBefore);

      const unshieldAmount = BigInt(50 * 1e6);
      const tx = await token.connect(bob)["unshield(uint64)"](unshieldAmount);

      // Pool still holds the public tokens — supply should be unchanged.
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), supplyBefore);

      const requestId = await getUnshieldRequestId(tx, token);
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(requestId).withoutPermit().execute();
      await token.connect(bob).claimUnshielded(requestId, decryption.decryptedValue, decryption.signature);

      // Claim drains the pool — supply now reflects the burn.
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), supplyBefore - unshieldAmount);
    });
  });

  describe("Confidential Transfers", function () {
    it("Should transfer encrypted tokens correctly", async function () {
      const { token, indicator, bob, alice, bobClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const transferAmount = BigInt(5 * 1e6);

      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferAmount)]).execute();

      await expect(
        token
          .connect(bob)
          ["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      const bobBalance = await token.confidentialBalanceOf(bob.address);
      const aliceBalance = await token.confidentialBalanceOf(alice.address);

      await hre.cofhe.mocks.expectPlaintext(bobBalance, BigInt(5 * 1e6));
      await hre.cofhe.mocks.expectPlaintext(aliceBalance, BigInt(5 * 1e6));

      expect(await indicator.balanceOf(bob.address)).to.equal(10110005000n);
      expect(await indicator.balanceOf(alice.address)).to.equal(10110005001n);
    });
  });

  describe("Operators", function () {
    it("Should allow operator to transfer confidential tokens", async function () {
      const { token, bob, alice, aliceClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      expect(await token.isOperator(bob.address, alice.address)).to.equal(true);

      const transferAmount = BigInt(3 * 1e6);
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferAmount)]).execute();

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      const bobBalance = await token.confidentialBalanceOf(bob.address);
      const aliceBalance = await token.confidentialBalanceOf(alice.address);

      await hre.cofhe.mocks.expectPlaintext(bobBalance, BigInt(7 * 1e6));
      await hre.cofhe.mocks.expectPlaintext(aliceBalance, BigInt(3 * 1e6));
    });

    it("Should revert transferFrom without operator approval", async function () {
      const { token, bob, alice, aliceClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const transferAmount = BigInt(3 * 1e6);
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferAmount)]).execute();

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, alice.address, encTransferInput),
      ).to.be.revertedWithCustomError(token, "ERC20ConfidentialUnauthorizedSpender");
    });
  });

  describe("Confidential Transfer And Call", function () {
    async function deployReceiver(): Promise<MockFHERC20Receiver> {
      const factory = await ethers.getContractFactory("MockFHERC20Receiver");
      const receiver = (await factory.deploy()) as MockFHERC20Receiver;
      await receiver.waitForDeployment();
      return receiver;
    }

    describe("confidentialTransferAndCall", function () {
      async function setupTransferAndCallFixture() {
        const { token, bob, alice, bobClient } = await setupFixture();

        await token.mint(bob.address, ethers.parseEther("10"));
        await token.connect(bob).shield(ethers.parseEther("10"));

        const receiver = await deployReceiver();

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

        return { token, bob, alice, receiver, encTransferInput, transferValue };
      }

      it("should transfer with callback to receiver (success)", async function () {
        const { token, bob, receiver, encTransferInput, transferValue } = await setupTransferAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

        const tx = await token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
          ](receiverAddress, encTransferInput, callData);

        await expect(tx).to.emit(receiver, "ConfidentialTransferCallback").withArgs(true);

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, receiverAddress, transferValue);
      });

      it("should transfer with callback to receiver (failure - refund)", async function () {
        const { token, bob, receiver, encTransferInput } = await setupTransferAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);

        await expect(
          token
            .connect(bob)
            [
              "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
            ](receiverAddress, encTransferInput, callData),
        ).to.emit(receiver, "ConfidentialTransferCallback");

        await expectFHERC20BalancesChange(token, bob.address, 0n);
        await expectFHERC20BalancesChange(token, receiverAddress, 0n);
      });

      it("should transfer with callback to EOA (always succeeds)", async function () {
        const { token, bob, alice, encTransferInput, transferValue } = await setupTransferAndCallFixture();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, alice.address);

        const tx = await token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
          ](alice.address, encTransferInput, "0x");

        await expect(tx).to.emit(token, "ConfidentialTransfer");

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, alice.address, transferValue);
      });

      it("should revert with custom error from callback", async function () {
        const { token, bob, receiver, encTransferInput } = await setupTransferAndCallFixture();

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [2]);

        await expect(
          token
            .connect(bob)
            [
              "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
            ](await receiver.getAddress(), encTransferInput, callData),
        )
          .to.be.revertedWithCustomError(receiver, "InvalidInput")
          .withArgs(2);
      });

      it("should revert on transfer to zero address", async function () {
        const { token, bob, encTransferInput } = await setupTransferAndCallFixture();

        await expect(
          token
            .connect(bob)
            [
              "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
            ](ZeroAddress, encTransferInput, "0x"),
        ).to.be.revertedWithCustomError(token, "ERC20InvalidReceiver");
      });
    });

    describe("confidentialTransferFromAndCall", function () {
      async function setupTransferFromAndCallFixture() {
        const { token, bob, alice, aliceClient } = await setupFixture();
        const [, , , eve] = await ethers.getSigners();
        const eveClient = await hre.cofhe.createClientWithBatteries(eve);

        await token.mint(bob.address, ethers.parseEther("10"));
        await token.connect(bob).shield(ethers.parseEther("10"));

        const receiver = await deployReceiver();

        return { token, bob, alice, eve, receiver, aliceClient, eveClient };
      }

      it("should transfer from bob to receiver with callback (as operator, success)", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

        const tx = await token
          .connect(alice)
          [
            "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
          ](bob.address, receiverAddress, encTransferInput, callData);

        await expect(tx).to.emit(receiver, "ConfidentialTransferCallback").withArgs(true);

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, receiverAddress, transferValue);
      });

      it("should transfer from bob to receiver with callback (failure - refund)", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
            ](bob.address, receiverAddress, encTransferInput, callData),
        ).to.emit(receiver, "ConfidentialTransferCallback");

        await expectFHERC20BalancesChange(token, bob.address, 0n);
        await expectFHERC20BalancesChange(token, receiverAddress, 0n);
      });

      it("should transfer from bob to alice (EOA) with callback via eve as operator", async function () {
        const { token, bob, alice, eve, eveClient } = await setupTransferFromAndCallFixture();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(eve.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput] = await eveClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, alice.address);

        const tx = await token
          .connect(eve)
          [
            "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
          ](bob.address, alice.address, encTransferInput, "0x");

        await expect(tx).to.emit(token, "ConfidentialTransfer");

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, alice.address, transferValue);
      });

      it("should revert without operator approval", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
            ](bob.address, await receiver.getAddress(), encTransferInput, callData),
        ).to.be.revertedWithCustomError(token, "ERC20ConfidentialUnauthorizedSpender");
      });

      it("should revert with custom error from callback", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [2]);

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
            ](bob.address, await receiver.getAddress(), encTransferInput, callData),
        )
          .to.be.revertedWithCustomError(receiver, "InvalidInput")
          .withArgs(2);
      });

      it("should revert on transfer to zero address", async function () {
        const { token, bob, alice, aliceClient } = await setupTransferFromAndCallFixture();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
            ](bob.address, ZeroAddress, encTransferInput, "0x"),
        ).to.be.revertedWithCustomError(token, "ERC20InvalidReceiver");
      });
    });
  });

  describe("Decimal Scenarios", function () {
    describe("4 Decimals (confidentialDecimals=4, rate=1)", function () {
      async function deploy4DecimalToken() {
        const [bob] = await ethers.getSigners();
        const token = await deployWithDecimals(4);
        const bobClient = await hre.cofhe.createClientWithBatteries(bob);
        return { token, bob, bobClient };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy4DecimalToken();
        expect(await token.decimals()).to.equal(4);
        expect(await token.confidentialDecimals()).to.equal(4);
      });

      it("Should shield/unshield with no precision loss", async function () {
        const { token, bob, bobClient } = await deploy4DecimalToken();

        const amount = BigInt(100000); // 10 * 10^4
        await token.mint(bob.address, amount);

        await token.connect(bob).shield(amount);

        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, amount);

        const tx = await token.connect(bob)["unshield(uint64)"](amount);
        const requestId = await getUnshieldRequestId(tx, token);

        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        const decryption = await bobClient.decryptForTx(requestId).withoutPermit().execute();
        await token.connect(bob).claimUnshielded(requestId, decryption.decryptedValue, decryption.signature);

        expect(await token.balanceOf(bob.address)).to.equal(amount);
      });
    });

    describe("6 Decimals (confidentialDecimals=6, rate=1)", function () {
      async function deploy6DecimalToken() {
        const [bob] = await ethers.getSigners();
        const token = await deployWithDecimals(6);
        const bobClient = await hre.cofhe.createClientWithBatteries(bob);
        return { token, bob, bobClient };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy6DecimalToken();
        expect(await token.decimals()).to.equal(6);
        expect(await token.confidentialDecimals()).to.equal(6);
      });

      it("Should shield/unshield with no precision loss", async function () {
        const { token, bob, bobClient } = await deploy6DecimalToken();

        const amount = BigInt(10000000); // 10 * 10^6
        await token.mint(bob.address, amount);

        await token.connect(bob).shield(amount);

        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, amount);

        const tx = await token.connect(bob)["unshield(uint64)"](amount);
        const requestId = await getUnshieldRequestId(tx, token);

        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        const decryption = await bobClient.decryptForTx(requestId).withoutPermit().execute();
        await token.connect(bob).claimUnshielded(requestId, decryption.decryptedValue, decryption.signature);

        expect(await token.balanceOf(bob.address)).to.equal(amount);
      });
    });

    describe("8 Decimals (confidentialDecimals=6, rate=100)", function () {
      async function deploy8DecimalToken() {
        const [bob] = await ethers.getSigners();
        const token = await deployWithDecimals(8);
        const bobClient = await hre.cofhe.createClientWithBatteries(bob);
        return { token, bob, bobClient };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy8DecimalToken();
        expect(await token.decimals()).to.equal(8);
        expect(await token.confidentialDecimals()).to.equal(6);
      });

      it("Should shield/unshield with correct rate conversion", async function () {
        const { token, bob, bobClient } = await deploy8DecimalToken();

        const publicAmount = BigInt(1000000000); // 10 * 10^8
        const expectedConfidentialAmount = BigInt(10000000); // 10 * 10^6

        await token.mint(bob.address, publicAmount);
        await token.connect(bob).shield(publicAmount);

        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, expectedConfidentialAmount);

        const tx = await token.connect(bob)["unshield(uint64)"](expectedConfidentialAmount);
        const requestId = await getUnshieldRequestId(tx, token);

        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        const decryption = await bobClient.decryptForTx(requestId).withoutPermit().execute();
        await token.connect(bob).claimUnshielded(requestId, decryption.decryptedValue, decryption.signature);

        expect(await token.balanceOf(bob.address)).to.equal(publicAmount);
      });

      it("Should fail to shield amounts smaller than rate", async function () {
        const { token, bob } = await deploy8DecimalToken();

        const dustAmount = BigInt(50);
        await token.mint(bob.address, BigInt(1000000));

        await expect(token.connect(bob).shield(dustAmount)).to.be.revertedWithCustomError(
          token,
          "AmountTooSmallForConfidentialPrecision",
        );
      });
    });
  });
}
