import hre, { ethers } from "hardhat";
import { MockERC20Confidential, ERC20ConfidentialIndicator } from "../typechain-types";
import { shouldBehaveLikeERC20Confidential } from "./ERC20Confidential.behavior";

describe("ERC20Confidential", function () {
  async function deployContracts() {
    const MockERC20ConfidentialFactory = await ethers.getContractFactory("MockERC20Confidential");
    const token = (await MockERC20ConfidentialFactory.deploy("Confidential Token", "CTK", 18)) as MockERC20Confidential;
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

  async function deployWithDecimals(decimals: number) {
    const Factory = await ethers.getContractFactory("MockERC20Confidential");
    const token = (await Factory.deploy("Test", "T", decimals)) as MockERC20Confidential;
    await token.waitForDeployment();
    return token;
  }

  shouldBehaveLikeERC20Confidential(setupFixture, deployWithDecimals);
});
