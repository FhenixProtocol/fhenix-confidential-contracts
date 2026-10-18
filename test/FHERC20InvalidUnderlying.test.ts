import { expect } from "chai";
import { ethers } from "hardhat";

const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

async function linkedFactory(name: string) {
  const library = await ethers.deployContract(LIB_FQN);
  await library.waitForDeployment();
  return ethers.getContractFactory(name, {
    libraries: { [LIB_FQN]: await library.getAddress() },
  });
}

describe("FHERC20 ERC20 wrapper underlying validation", function () {
  for (const kind of ["zero address", "EOA"] as const) {
    it(`rejects a ${kind} in the constructor-based wrapper`, async function () {
      const [, eoa] = await ethers.getSigners();
      const invalidUnderlying = kind === "zero address" ? ethers.ZeroAddress : eoa.address;
      const factory = await linkedFactory("FHERC20ERC20Wrapper_Harness");
      const errorInterface = factory.attach(ethers.ZeroAddress);

      await expect(factory.deploy(invalidUnderlying, "Wrapped", "eWRAP", ""))
        .to.be.revertedWithCustomError(errorInterface, "FHERC20InvalidUnderlying")
        .withArgs(invalidUnderlying);
    });

    it(`rejects a ${kind} during atomic UUPS initialization`, async function () {
      const [, owner, eoa] = await ethers.getSigners();
      const invalidUnderlying = kind === "zero address" ? ethers.ZeroAddress : eoa.address;
      const factory = await linkedFactory("FHERC20ERC20WrapperUUPS");
      const implementation = await factory.deploy();
      await implementation.waitForDeployment();
      const initData = implementation.interface.encodeFunctionData("initialize", [
        invalidUnderlying,
        "Wrapped",
        "eWRAP",
        "",
        owner.address,
      ]);
      const proxyFactory = await ethers.getContractFactory("ERC1967Proxy");

      await expect(proxyFactory.deploy(await implementation.getAddress(), initData))
        .to.be.revertedWithCustomError(implementation, "FHERC20InvalidUnderlying")
        .withArgs(invalidUnderlying);
    });
  }
});
