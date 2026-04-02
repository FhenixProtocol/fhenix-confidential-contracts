import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { MockERC20Confidential, ERC20ConfidentialIndicator } from "../typechain-types";
import { CofheClient, Encryptable } from "@cofhe/sdk";
import { ContractTransactionResponse } from "ethers";
import { prepExpectERC20BalancesChange, expectERC20BalancesChange } from "./utils";

async function getUnshieldRequestId(
  tx: ContractTransactionResponse,
  contract: MockERC20Confidential,
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

describe("ERC20Confidential", function () {
  async function deployContracts() {
    const MockERC20ConfidentialFactory = await ethers.getContractFactory("MockERC20Confidential");
    const token = (await MockERC20ConfidentialFactory.deploy(
      "Confidential Token",
      "CTK",
      18,
    )) as MockERC20Confidential;
    await token.waitForDeployment();

    const indicatorAddress = await token.indicatorToken();
    const indicator = (await ethers.getContractAt(
      "ERC20ConfidentialIndicator",
      indicatorAddress,
    )) as ERC20ConfidentialIndicator;

    return { token, indicator };
  }

  async function setupFixture() {
    const [owner, bob, alice] = await ethers.getSigners();
    const { token, indicator } = await deployContracts();

    const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);

    return { owner, bob, alice, token, indicator, ownerClient, bobClient, aliceClient };
  }

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

      const tx = await token.connect(bob).unshield(unshieldAmountConfidential);
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
      )
        .to.emit(token, "UnshieldedTokensClaimed");

      expect(await token.balanceOf(bob.address)).to.equal(unshieldAmountPublic);
    });

    it("Should support multiple concurrent unshield claims", async function () {
      const { token, bob, bobClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const tx1 = await token.connect(bob).unshield(BigInt(3 * 1e6));
      const requestId1 = await getUnshieldRequestId(tx1, token);

      const tx2 = await token.connect(bob).unshield(BigInt(2 * 1e6));
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
          ["confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"](
            bob.address,
            alice.address,
            encTransferInput,
          ),
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
          ["confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"](
            bob.address,
            alice.address,
            encTransferInput,
          ),
      ).to.be.revertedWithCustomError(token, "ERC20ConfidentialUnauthorizedSpender");
    });
  });

  describe("Decimal Scenarios", function () {
    describe("4 Decimals (confidentialDecimals=4, rate=1)", function () {
      async function deploy4DecimalToken() {
        const [owner, bob] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("MockERC20Confidential");
        const token = (await Factory.deploy("4Dec Token", "4DEC", 4)) as MockERC20Confidential;
        await token.waitForDeployment();

        const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
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

        const tx = await token.connect(bob).unshield(amount);
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
        const [owner, bob] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("MockERC20Confidential");
        const token = (await Factory.deploy("6Dec Token", "6DEC", 6)) as MockERC20Confidential;
        await token.waitForDeployment();

        const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
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

        const tx = await token.connect(bob).unshield(amount);
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
        const [owner, bob] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("MockERC20Confidential");
        const token = (await Factory.deploy("8Dec Token", "8DEC", 8)) as MockERC20Confidential;
        await token.waitForDeployment();

        const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
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

        const tx = await token.connect(bob).unshield(expectedConfidentialAmount);
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
});
