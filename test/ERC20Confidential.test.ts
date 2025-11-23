import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { MockERC20Confidential, ERC20ConfidentialIndicator } from "../typechain-types";
import { cofhejs, Encryptable } from "cofhejs/node";
import { prepExpectERC20BalancesChange } from "./utils";

describe("ERC20Confidential", function () {
  async function deployContracts() {
    const MockERC20ConfidentialFactory = await ethers.getContractFactory("MockERC20Confidential");
    const token = (await MockERC20ConfidentialFactory.deploy("Confidential Token", "CTK")) as MockERC20Confidential;
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

  describe("Wrapping (Public -> Confidential)", function () {
    it("Should wrap tokens correctly", async function () {
      const { token, indicator, bob } = await setupFixture();

      // 1. Mint public tokens to Bob (Mock function)
      const mintAmount = ethers.parseEther("100"); // 100 * 1e18
      await token.mint(bob.address, mintAmount);

      expect(await token.balanceOf(bob.address)).to.equal(mintAmount);

      // 2. Wrap tokens
      const wrapAmount = ethers.parseEther("10"); // 10 * 1e18
      const expectedConfidentialAmount = BigInt(10 * 1e6); // 10 * 1e6

      await prepExpectERC20BalancesChange(token, bob.address);
      // Note: We can't use expectFHERC20BalancesChange easily here because the token ITSELF is the FHERC20,
      // but the "confidential" balance is separate. We'll verify manually.

      // Wrap
      await expect(token.connect(bob).wrap(wrapAmount))
        .to.emit(token, "TokensWrapped")
        .withArgs(bob.address, wrapAmount);

      // Verify Public Balance Decrease
      expect(await token.balanceOf(bob.address)).to.equal(mintAmount - wrapAmount);

      // Verify Confidential Balance Increase
      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, expectedConfidentialAmount);

      // Indicated balance starts at 10110000000 + 0 (implicit).
      // After receiving, it should be 10110000000 + 5001 (first interaction).
      expect(await indicator.balanceOf(bob.address)).to.equal(10110005001n);
    });

    it("Should fail to wrap amounts too small for confidential precision", async function () {
      const { token, bob } = await setupFixture();

      // Rate is 1e12 (18 decimals -> 6 decimals)
      // Amount < 1e12 should fail
      const dustAmount = BigInt(1e11);
      await token.mint(bob.address, ethers.parseEther("1"));

      await expect(token.connect(bob).wrap(dustAmount)).to.be.revertedWithCustomError(
        token,
        "AmountTooSmallForConfidentialPrecision",
      );
    });
  });

  describe("Unwrapping (Confidential -> Public)", function () {
    it("Should unwrap tokens correctly", async function () {
      const { token, bob } = await setupFixture();

      // Setup: Mint and Wrap
      const initialAmount = ethers.parseEther("100");
      await token.mint(bob.address, initialAmount);
      await token.connect(bob).wrap(initialAmount);

      // Unwrap half
      const unwrapAmountConfidential = BigInt(50 * 1e6); // 50 tokens
      const unwrapAmountPublic = ethers.parseEther("50");

      // Request Unwrap

      await expect(token.connect(bob).unwrap(unwrapAmountConfidential)).to.emit(token, "TokensUnwrapped");

      // Hardhat time travel 11 seconds
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, BigInt(50 * 1e6));

      // Public balance should NOT increase yet
      expect(await token.balanceOf(bob.address)).to.equal(0);

      // Claim
      await expect(token.connect(bob).claimUnwrapped())
        .to.emit(token, "UnwrappedTokensClaimed")
        .withArgs(bob.address, unwrapAmountPublic);

      // Verify Public Balance Increase
      expect(await token.balanceOf(bob.address)).to.equal(unwrapAmountPublic);
    });

    it("Should fail if user has active unwrap claim", async function () {
      const { token, bob } = await setupFixture();
      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).wrap(ethers.parseEther("10"));

      await token.connect(bob).unwrap(BigInt(1e6)); // 1 token

      await expect(token.connect(bob).unwrap(BigInt(1e6))).to.be.revertedWithCustomError(
        token,
        "UserHasActiveUnwrapClaim",
      );
    });
  });

  describe("Confidential Transfers", function () {
    it("Should transfer encrypted tokens correctly", async function () {
      const { token, indicator, bob, alice } = await setupFixture();

      // Setup Bob
      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).wrap(ethers.parseEther("10"));

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
});
