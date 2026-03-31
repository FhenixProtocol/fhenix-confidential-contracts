import hre, { ethers } from "hardhat";
import { FHERC20_Harness } from "../typechain-types";
import { shouldBehaveLikeFHERC20 } from "./FHERC20.behavior";

describe("FHERC20", function () {
  const deployContracts = async () => {
    const factory = await ethers.getContractFactory("FHERC20_Harness");
    const token = await factory.deploy("Test Token", "TST", 6, "https://example.com/contract.json");
    await token.waitForDeployment();
    return { token };
  };

  async function setupFixture() {
    const [owner, bob, alice, eve] = await ethers.getSigners();
    const { token } = await deployContracts();

    const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const eveClient = await hre.cofhe.createClientWithBatteries(eve);

    return { ownerClient, bobClient, aliceClient, eveClient, owner, bob, alice, eve, token };
  }

  async function deployWithDecimals(decimals: number) {
    const factory = await ethers.getContractFactory("FHERC20_Harness");
    const token = (await factory.deploy("Test", "T", decimals, "")) as FHERC20_Harness;
    await token.waitForDeployment();
    return token;
  }

  shouldBehaveLikeFHERC20(setupFixture, deployWithDecimals);
});
