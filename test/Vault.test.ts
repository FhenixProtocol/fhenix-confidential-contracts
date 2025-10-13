import hre, { ethers } from "hardhat";
import { FHERC20_Harness, MockVault } from "../typechain-types";
import { cofhejs, Encryptable } from "cofhejs/node";
import { expect } from "chai";
import { expectFHERC20BalancesChange, prepExpectFHERC20BalancesChange, tick, ticksToIndicated } from "./utils";

describe("MockVault (confidentialTransferFrom)", function () {
  // We define a fixture to reuse the same setup in every test.
  const deployContracts = async () => {
    // Deploy XFHE
    const XFHEFactory = await ethers.getContractFactory("FHERC20_Harness");
    const XFHE = (await XFHEFactory.deploy("Unknown FHERC20", "XFHE", 18)) as FHERC20_Harness;
    const XFHEAddress = await XFHE.getAddress();
    await XFHE.waitForDeployment();

    // Deploy Vault
    const MockVaultFactory = await ethers.getContractFactory("MockVault");
    const MockVault = (await MockVaultFactory.deploy(XFHEAddress)) as MockVault;
    await MockVault.waitForDeployment();

    return { XFHE, Vault: MockVault };
  };

  async function setupFixture() {
    const [owner, bob, alice, eve] = await ethers.getSigners();
    const { XFHE, Vault } = await deployContracts();

    await hre.cofhe.initializeWithHardhatSigner(owner);

    // Give bob and alice XFHE
    const mintValue = ethers.parseEther("10");
    await XFHE.mint(bob, mintValue);
    await XFHE.mint(alice, mintValue);

    return { owner, bob, alice, eve, XFHE, Vault };
  }

  describe("Deposit", async function () {
    it("test", async function () {
      const { bob, XFHE, Vault } = await setupFixture();
      const VaultAddress = await Vault.getAddress();

      // Mint to vault (initialize indicator)
      await XFHE.mint(VaultAddress, await ethers.parseEther("1"));

      // Encrypt transfer value
      const transferValue = ethers.parseEther("1");
      const encTransferResult = await cofhejs.encrypt([Encryptable.uint64(transferValue)] as const);
      const [encTransferInput] = await hre.cofhe.expectResultSuccess(encTransferResult);

      // Success - Bob -> Vault

      // Set vault as operator for bob
      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await XFHE.connect(bob).setOperator(VaultAddress, timestamp);

      await prepExpectFHERC20BalancesChange(XFHE, bob.address);
      await prepExpectFHERC20BalancesChange(XFHE, VaultAddress);

      await expect(Vault.connect(bob).deposit(encTransferInput))
        .to.emit(XFHE, "Transfer")
        .withArgs(bob.address, VaultAddress, await tick(XFHE));

      await expectFHERC20BalancesChange(
        XFHE,
        bob.address,
        -1n * (await ticksToIndicated(XFHE, 1n)),
        -1n * transferValue,
      );
      await expectFHERC20BalancesChange(
        XFHE,
        VaultAddress,
        1n * (await ticksToIndicated(XFHE, 1n)),
        1n * transferValue,
      );

      // Bob Vault Balance
      const bobBalance = await Vault.balances(bob.address);
      await hre.cofhe.mocks.expectPlaintext(bobBalance, transferValue);
    });
  });
});
