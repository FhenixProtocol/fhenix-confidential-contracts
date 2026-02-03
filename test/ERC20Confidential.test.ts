import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { MockERC20Confidential, ERC20ConfidentialIndicator } from "../typechain-types";
import { cofhejs, Encryptable } from "cofhejs/node";
import { prepExpectERC20BalancesChange } from "./utils";

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

    await hre.cofhe.initializeWithHardhatSigner(owner);
    await hre.cofhe.initializeWithHardhatSigner(bob);
    await hre.cofhe.initializeWithHardhatSigner(alice);

    return { owner, bob, alice, token, indicator };
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

      // 1. Mint public tokens to Bob (Mock function)
      const mintAmount = ethers.parseEther("100"); // 100 * 1e18
      await token.mint(bob.address, mintAmount);

      expect(await token.balanceOf(bob.address)).to.equal(mintAmount);

      // 2. Shield tokens
      const shieldAmount = ethers.parseEther("10"); // 10 * 1e18
      const expectedConfidentialAmount = BigInt(10 * 1e6); // 10 * 1e6

      await prepExpectERC20BalancesChange(token, bob.address);
      // Note: We can't use expectFHERC20BalancesChange easily here because the token ITSELF is the FHERC20,
      // but the "confidential" balance is separate. We'll verify manually.

      // Shield
      await expect(token.connect(bob).shield(shieldAmount))
        .to.emit(token, "TokensShielded")
        .withArgs(bob.address, shieldAmount);

      // Verify Public Balance Decrease
      expect(await token.balanceOf(bob.address)).to.equal(mintAmount - shieldAmount);

      // Verify Confidential Balance Increase
      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, expectedConfidentialAmount);

      // Indicated balance starts at 10110000000 + 0 (implicit).
      // After receiving, it should be 10110000000 + 5001 (first interaction).
      expect(await indicator.balanceOf(bob.address)).to.equal(10110005001n);
    });

    it("Should fail to shield amounts too small for confidential precision", async function () {
      const { token, bob } = await setupFixture();

      // Rate is 1e12 (18 decimals -> 6 decimals)
      // Amount < 1e12 should fail
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
      const { token, bob } = await setupFixture();

      // Setup: Mint and Shield
      const initialAmount = ethers.parseEther("100");
      await token.mint(bob.address, initialAmount);
      await token.connect(bob).shield(initialAmount);

      // Unshield half
      const unshieldAmountConfidential = BigInt(50 * 1e6); // 50 tokens
      const unshieldAmountPublic = ethers.parseEther("50");

      // Request Unshield

      await expect(token.connect(bob).unshield(unshieldAmountConfidential)).to.emit(token, "TokensUnshielded");

      // Hardhat time travel 11 seconds
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, BigInt(50 * 1e6));

      // Public balance should NOT increase yet
      expect(await token.balanceOf(bob.address)).to.equal(0);

      // Claim
      await expect(token.connect(bob).claimUnshielded())
        .to.emit(token, "UnshieldedTokensClaimed")
        .withArgs(bob.address, unshieldAmountPublic);

      // Verify Public Balance Increase
      expect(await token.balanceOf(bob.address)).to.equal(unshieldAmountPublic);
    });

    it("Should fail if user has active unshield claim", async function () {
      const { token, bob } = await setupFixture();
      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      await token.connect(bob).unshield(BigInt(1e6)); // 1 token

      await expect(token.connect(bob).unshield(BigInt(1e6))).to.be.revertedWithCustomError(
        token,
        "UserHasActiveUnshieldClaim",
      );
    });
  });

  describe("Confidential Transfers", function () {
    it("Should transfer encrypted tokens correctly", async function () {
      const { token, indicator, bob, alice } = await setupFixture();

      // Setup Bob
      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      // Transfer 5 tokens from Bob to Alice
      const transferAmount = BigInt(5 * 1e6);

      // Encrypt transfer value
      const encTransferResult = await cofhejs.encrypt([Encryptable.uint64(transferAmount)] as const);
      const [encTransferInput] = await hre.cofhe.expectResultSuccess(encTransferResult);

      // Using the input proof version:
      await expect(
        token
          .connect(bob)
          ["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      // Verify Balances
      const bobBalance = await token.confidentialBalanceOf(bob.address);
      const aliceBalance = await token.confidentialBalanceOf(alice.address);

      await hre.cofhe.mocks.expectPlaintext(bobBalance, BigInt(5 * 1e6));
      await hre.cofhe.mocks.expectPlaintext(aliceBalance, BigInt(5 * 1e6));

      // Verify Indicator Balances
      // Bob: Initial (5001) -> Transfer Out (decrements to 5000)
      // Alice: Initial (0) -> Transfer In (increments to 5001)
      expect(await indicator.balanceOf(bob.address)).to.equal(10110005000n);
      expect(await indicator.balanceOf(alice.address)).to.equal(10110005001n);
    });
  });

  describe("Decimal Scenarios", function () {
    describe("4 Decimals (confidentialDecimals=4, rate=1)", function () {
      async function deploy4DecimalToken() {
        const [owner, bob] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("MockERC20Confidential");
        const token = (await Factory.deploy("4Dec Token", "4DEC", 4)) as MockERC20Confidential;
        await token.waitForDeployment();

        await hre.cofhe.initializeWithHardhatSigner(owner);
        await hre.cofhe.initializeWithHardhatSigner(bob);

        return { token, bob };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy4DecimalToken();
        expect(await token.decimals()).to.equal(4);
        expect(await token.confidentialDecimals()).to.equal(4);
      });

      it("Should shield/unshield with no precision loss", async function () {
        const { token, bob } = await deploy4DecimalToken();

        // Mint 10.0000 tokens (4 decimals)
        const amount = BigInt(100000); // 10 * 10^4
        await token.mint(bob.address, amount);

        // Shield
        await token.connect(bob).shield(amount);

        // Verify confidential balance (should be same amount, rate=1)
        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, amount);

        // Unshield
        await token.connect(bob).unshield(amount);
        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        // Claim
        await token.connect(bob).claimUnshielded();

        // Verify public balance restored
        expect(await token.balanceOf(bob.address)).to.equal(amount);
      });
    });

    describe("6 Decimals (confidentialDecimals=6, rate=1)", function () {
      async function deploy6DecimalToken() {
        const [owner, bob] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("MockERC20Confidential");
        const token = (await Factory.deploy("6Dec Token", "6DEC", 6)) as MockERC20Confidential;
        await token.waitForDeployment();

        await hre.cofhe.initializeWithHardhatSigner(owner);
        await hre.cofhe.initializeWithHardhatSigner(bob);

        return { token, bob };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy6DecimalToken();
        expect(await token.decimals()).to.equal(6);
        expect(await token.confidentialDecimals()).to.equal(6);
      });

      it("Should shield/unshield with no precision loss", async function () {
        const { token, bob } = await deploy6DecimalToken();

        // Mint 10.000000 tokens (6 decimals)
        const amount = BigInt(10000000); // 10 * 10^6
        await token.mint(bob.address, amount);

        // Shield
        await token.connect(bob).shield(amount);

        // Verify confidential balance (should be same amount, rate=1)
        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, amount);

        // Unshield
        await token.connect(bob).unshield(amount);
        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        // Claim
        await token.connect(bob).claimUnshielded();

        // Verify public balance restored
        expect(await token.balanceOf(bob.address)).to.equal(amount);
      });
    });

    describe("8 Decimals (confidentialDecimals=6, rate=100)", function () {
      async function deploy8DecimalToken() {
        const [owner, bob] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("MockERC20Confidential");
        const token = (await Factory.deploy("8Dec Token", "8DEC", 8)) as MockERC20Confidential;
        await token.waitForDeployment();

        await hre.cofhe.initializeWithHardhatSigner(owner);
        await hre.cofhe.initializeWithHardhatSigner(bob);

        return { token, bob };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy8DecimalToken();
        expect(await token.decimals()).to.equal(8);
        expect(await token.confidentialDecimals()).to.equal(6);
      });

      it("Should shield/unshield with correct rate conversion", async function () {
        const { token, bob } = await deploy8DecimalToken();

        // Mint 1000000000 (10.00000000 with 8 decimals)
        const publicAmount = BigInt(1000000000); // 10 * 10^8
        const expectedConfidentialAmount = BigInt(10000000); // 10 * 10^6 (rate=100)

        await token.mint(bob.address, publicAmount);

        // Shield
        await token.connect(bob).shield(publicAmount);

        // Verify confidential balance (scaled down by rate=100)
        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, expectedConfidentialAmount);

        // Unshield
        await token.connect(bob).unshield(expectedConfidentialAmount);
        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        // Claim
        await token.connect(bob).claimUnshielded();

        // Verify public balance restored (scaled back up by rate=100)
        expect(await token.balanceOf(bob.address)).to.equal(publicAmount);
      });

      it("Should fail to shield amounts smaller than rate", async function () {
        const { token, bob } = await deploy8DecimalToken();

        // Rate is 100 (8 decimals -> 6 decimals)
        // Amount < 100 should fail
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
