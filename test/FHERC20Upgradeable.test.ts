import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { FHERC20Upgradeable_Harness } from "../typechain-types";
import { shouldBehaveLikeFHERC20 } from "./FHERC20.behavior";

describe("FHERC20Upgradeable", function () {
  async function deployProxy(
    name: string,
    symbol: string,
    decimals: number,
    contractURI: string,
  ): Promise<FHERC20Upgradeable_Harness> {
    const implFactory = await ethers.getContractFactory("FHERC20Upgradeable_Harness");
    const impl = await implFactory.deploy();
    await impl.waitForDeployment();

    const initData = impl.interface.encodeFunctionData("initialize", [name, symbol, decimals, contractURI]);

    const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await proxyFactory.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    return implFactory.attach(await proxy.getAddress()) as FHERC20Upgradeable_Harness;
  }

  // =========================================================================
  //  Shared FHERC20 behavior tests
  // =========================================================================

  async function setupFixture() {
    const [owner, bob, alice, eve] = await ethers.getSigners();
    const token = await deployProxy("Test Token", "TST", 6, "https://example.com/contract.json");

    const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const eveClient = await hre.cofhe.createClientWithBatteries(eve);

    return { ownerClient, bobClient, aliceClient, eveClient, owner, bob, alice, eve, token };
  }

  async function deployWithDecimals(decimals: number) {
    return deployProxy("Test", "T", decimals, "");
  }

  shouldBehaveLikeFHERC20(setupFixture, deployWithDecimals);

  // =========================================================================
  //  Upgradeable-specific tests
  // =========================================================================

  describe("upgradeable-specific", function () {
    it("should not allow calling initialize twice", async function () {
      const token = await deployProxy("Test Token", "TST", 6, "https://example.com/contract.json");

      await expect(token.initialize("Reuse", "RE", 18, "")).to.be.revertedWithCustomError(
        token,
        "InvalidInitialization",
      );
    });

    it("should not allow calling initialize on the implementation directly", async function () {
      const implFactory = await ethers.getContractFactory("FHERC20Upgradeable_Harness");
      const impl = await implFactory.deploy();
      await impl.waitForDeployment();

      const initData = impl.interface.encodeFunctionData("initialize", ["X", "X", 6, ""]);
      const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");
      const proxy = await proxyFactory.deploy(await impl.getAddress(), initData);
      await proxy.waitForDeployment();

      await expect(impl.initialize("Impl", "IMP", 18, "")).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    it("should persist storage through the proxy", async function () {
      const token = await deployProxy("Proxy Token", "PTK", 8, "https://proxy.example.com");

      expect(await token.name()).to.equal("Proxy Token");
      expect(await token.symbol()).to.equal("PTK");
      expect(await token.decimals()).to.equal(8);
      expect(await token.contractURI()).to.equal("https://proxy.example.com");
    });

    it("should persist minted balances through the proxy", async function () {
      const [, bob] = await ethers.getSigners();
      const token = await deployProxy("Proxy Token", "PTK", 6, "");

      await token.mint(bob.address, 1_000_000n);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), 1_000_000n);
    });
  });
});
