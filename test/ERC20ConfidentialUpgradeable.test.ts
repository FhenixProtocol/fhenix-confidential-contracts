import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ERC20ConfidentialUpgradeable_Harness, ERC20ConfidentialIndicator } from "../typechain-types";
import { shouldBehaveLikeERC20Confidential } from "./ERC20Confidential.behavior";

describe("ERC20ConfidentialUpgradeable", function () {
  async function deployProxy(
    name: string,
    symbol: string,
    decimals: number,
  ): Promise<ERC20ConfidentialUpgradeable_Harness> {
    const implFactory = await ethers.getContractFactory("ERC20ConfidentialUpgradeable_Harness");
    const impl = await implFactory.deploy();
    await impl.waitForDeployment();

    const initData = impl.interface.encodeFunctionData("initialize", [name, symbol, decimals]);

    const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await proxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    return implFactory.attach(await proxy.getAddress()) as ERC20ConfidentialUpgradeable_Harness;
  }

  // =========================================================================
  //  Shared ERC20Confidential behavior tests
  // =========================================================================

  async function setupFixture() {
    const [owner, bob, alice] = await ethers.getSigners();
    const token = await deployProxy("Confidential Token", "CTK", 18);

    const indicatorAddress = await token.indicatorToken();
    const indicator = (await ethers.getContractAt(
      "ERC20ConfidentialIndicator",
      indicatorAddress,
    )) as ERC20ConfidentialIndicator;

    const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);

    return { owner, bob, alice, token, indicator, ownerClient, bobClient, aliceClient };
  }

  async function deployWithDecimals(decimals: number) {
    return deployProxy("Test", "T", decimals);
  }

  shouldBehaveLikeERC20Confidential(setupFixture, deployWithDecimals);

  // =========================================================================
  //  Upgradeable-specific tests
  // =========================================================================

  describe("upgradeable-specific", function () {
    it("should not allow calling initialize twice", async function () {
      const token = await deployProxy("Test Token", "TST", 6);

      await expect(token.initialize("Reuse", "RE", 18)).to.be.revertedWithCustomError(token, "InvalidInitialization");
    });

    it("should not allow calling initialize on the implementation directly", async function () {
      const implFactory = await ethers.getContractFactory("ERC20ConfidentialUpgradeable_Harness");
      const impl = await implFactory.deploy();
      await impl.waitForDeployment();

      await expect(impl.initialize("Impl", "IMP", 18)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("should persist storage through the proxy", async function () {
      const token = await deployProxy("Proxy Token", "PTK", 8);

      expect(await token.name()).to.equal("Proxy Token");
      expect(await token.symbol()).to.equal("PTK");
      expect(await token.decimals()).to.equal(8);
      expect(await token.confidentialDecimals()).to.equal(6);
    });

    it("should persist confidential balance and total supply through the proxy", async function () {
      const [, bob] = await ethers.getSigners();
      const token = await deployProxy("Proxy Token", "PTK", 6);

      await token.mint(bob.address, 1_000_000n);
      await token.connect(bob).shield(1_000_000n);

      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), 1_000_000n);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialBalanceOf(bob.address), 1_000_000n);
    });

    it("should persist operator state through the proxy", async function () {
      const [, bob, alice] = await ethers.getSigners();
      const token = await deployProxy("Proxy Token", "PTK", 6);

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      expect(await token.isOperator(bob.address, alice.address)).to.equal(true);
    });

    it("should deploy a fresh indicator whose parent is the proxy", async function () {
      const token = await deployProxy("Proxy Token", "PTK", 6);
      const indicatorAddress = await token.indicatorToken();
      const indicator = await ethers.getContractAt("ERC20ConfidentialIndicator", indicatorAddress);

      // The init body runs via delegatecall from the proxy, so address(this) is the proxy,
      // and the indicator's immutable `parent` should match the proxy address.
      expect(await indicator.parent()).to.equal(await token.getAddress());

      // The indicator's name/symbol are derived from the parent's at init time.
      expect(await indicator.name()).to.equal("1011000 Proxy Token");
      expect(await indicator.symbol()).to.equal("cPTK");
    });

    it("should keep storage isolated between two proxies sharing one implementation", async function () {
      const [, bob] = await ethers.getSigners();

      const implFactory = await ethers.getContractFactory("ERC20ConfidentialUpgradeable_Harness");
      const impl = await implFactory.deploy();
      await impl.waitForDeployment();
      const implAddress = await impl.getAddress();

      const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");

      const initA = impl.interface.encodeFunctionData("initialize", ["Token A", "A", 6]);
      const proxyA = await proxyFactory.deploy(implAddress, initA);
      await proxyA.waitForDeployment();
      const tokenA = implFactory.attach(await proxyA.getAddress()) as ERC20ConfidentialUpgradeable_Harness;

      const initB = impl.interface.encodeFunctionData("initialize", ["Token B", "B", 6]);
      const proxyB = await proxyFactory.deploy(implAddress, initB);
      await proxyB.waitForDeployment();
      const tokenB = implFactory.attach(await proxyB.getAddress()) as ERC20ConfidentialUpgradeable_Harness;

      await tokenA.mint(bob.address, 1_000_000n);
      await tokenA.connect(bob).shield(1_000_000n);

      await tokenB.mint(bob.address, 2_000_000n);
      await tokenB.connect(bob).shield(2_000_000n);

      // Each proxy has its own confidential balance, indicator, and metadata.
      await hre.cofhe.mocks.expectPlaintext(await tokenA.confidentialBalanceOf(bob.address), 1_000_000n);
      await hre.cofhe.mocks.expectPlaintext(await tokenB.confidentialBalanceOf(bob.address), 2_000_000n);

      expect(await tokenA.indicatorToken()).to.not.equal(await tokenB.indicatorToken());
      expect(await tokenA.name()).to.equal("Token A");
      expect(await tokenB.name()).to.equal("Token B");
    });
  });
});
