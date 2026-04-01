import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { CofheClient, Encryptable } from "@cofhe/sdk";
import { prepExpectFHERC20BalancesChange, expectFHERC20BalancesChange } from "./utils";
import { ZeroAddress } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { FHERC20_Harness, FHERC20Upgradeable_Harness } from "../typechain-types";

type FHERC20Token = FHERC20_Harness | FHERC20Upgradeable_Harness;

export interface SetupFixtureResult {
  token: FHERC20Token;
  owner: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  eve: HardhatEthersSigner;
  ownerClient: CofheClient;
  bobClient: CofheClient;
  aliceClient: CofheClient;
  eveClient: CofheClient;
}

type SetupFixtureFn = () => Promise<SetupFixtureResult>;
type DeployWithDecimalsFn = (decimals: number) => Promise<FHERC20Token>;

// =========================================================================
//  Interface ID helpers
// =========================================================================

export function computeInterfaceId(selectors: string[]): string {
  let interfaceId = 0n;
  for (const sig of selectors) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(sig));
    const selector = BigInt(hash.slice(0, 10));
    interfaceId ^= selector;
  }
  return "0x" + interfaceId.toString(16).padStart(8, "0");
}

export function getIERC20InterfaceId(): string {
  return computeInterfaceId([
    "totalSupply()",
    "balanceOf(address)",
    "transfer(address,uint256)",
    "allowance(address,address)",
    "approve(address,uint256)",
    "transferFrom(address,address,uint256)",
  ]);
}

export function getIERC7984InterfaceId(): string {
  return computeInterfaceId([
    "name()",
    "symbol()",
    "decimals()",
    "contractURI()",
    "confidentialTotalSupply()",
    "confidentialBalanceOf(address)",
    "isOperator(address,address)",
    "setOperator(address,uint48)",
    "confidentialTransfer(address,(uint256,uint8,uint8,bytes))",
    "confidentialTransfer(address,bytes32)",
    "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))",
    "confidentialTransferFrom(address,address,bytes32)",
    "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)",
    "confidentialTransferAndCall(address,bytes32,bytes)",
    "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)",
    "confidentialTransferFromAndCall(address,address,bytes32,bytes)",
  ]);
}

export function getIFHERC20InterfaceId(): string {
  return computeInterfaceId(["balanceOfIsIndicator()", "indicatorTick()"]);
}

// =========================================================================
//  Shared behavior suites
// =========================================================================

export function shouldBehaveLikeFHERC20(setupFixture: SetupFixtureFn, deployWithDecimals: DeployWithDecimalsFn) {
  describe("initialization", function () {
    it("should be initialized correctly", async function () {
      const { token } = await setupFixture();

      expect(await token.name()).to.equal("Test Token");
      expect(await token.symbol()).to.equal("TST");
      expect(await token.decimals()).to.equal(6);
      expect(await token.contractURI()).to.equal("https://example.com/contract.json");
      expect(await token.confidentialTotalSupply()).to.equal(0n);
    });

    it("should support IFHERC20, IERC7984, IERC20 and ERC165 interfaces", async function () {
      const { token } = await setupFixture();

      expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true);
      expect(await token.supportsInterface(getIERC7984InterfaceId())).to.equal(true);
      expect(await token.supportsInterface(getIFHERC20InterfaceId())).to.equal(true);
      expect(await token.supportsInterface(getIERC20InterfaceId())).to.equal(true);
      expect(await token.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });

  describe("mint", function () {
    it("should mint tokens", async function () {
      const { bob, token } = await setupFixture();

      expect(await token.confidentialTotalSupply()).to.equal(0n);

      const value = 1_000_000n;

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await token.mint(bob.address, value);
      await expectFHERC20BalancesChange(token, bob.address, value);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), value);

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await token.mint(bob.address, value);
      await expectFHERC20BalancesChange(token, bob.address, value);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), value * 2n);
    });

    it("should revert if minting to the zero address", async function () {
      const { token } = await setupFixture();
      await expect(token.mint(ZeroAddress, 1_000_000n)).to.be.revertedWithCustomError(token, "FHERC20InvalidReceiver");
    });

    it("should emit ConfidentialTransfer event on mint", async function () {
      const { bob, token } = await setupFixture();
      await expect(token.mint(bob.address, 1_000_000n)).to.emit(token, "ConfidentialTransfer");
    });
  });

  describe("burn", function () {
    it("should burn tokens", async function () {
      const { token, bob } = await setupFixture();

      const mintValue = 10_000_000n;
      const burnValue = 1_000_000n;

      await token.mint(bob.address, mintValue);
      await prepExpectFHERC20BalancesChange(token, bob.address);
      await token.burn(bob.address, burnValue);
      await expectFHERC20BalancesChange(token, bob.address, -1n * burnValue);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), mintValue - burnValue);
    });

    it("should revert if burning from the zero address", async function () {
      const { token } = await setupFixture();
      await expect(token.burn(ZeroAddress, 1_000_000n)).to.be.revertedWithCustomError(token, "FHERC20InvalidSender");
    });

    it("should emit ConfidentialTransfer event on burn", async function () {
      const { bob, token } = await setupFixture();
      await token.mint(bob.address, 10_000_000n);
      await expect(token.burn(bob.address, 1_000_000n)).to.emit(token, "ConfidentialTransfer");
    });
  });

  describe("confidentialTransfer", function () {
    it("should transfer from bob to alice (InEuint64)", async function () {
      const { token, bob, alice, bobClient } = await setupFixture();

      const mintValue = 10_000_000n;
      await token.mint(bob.address, mintValue);
      await token.mint(alice.address, mintValue);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, alice.address);

      await expect(
        token
          .connect(bob)
          ["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
      await expectFHERC20BalancesChange(token, alice.address, transferValue);
    });

    it("should revert on transfer to zero address", async function () {
      const { token, bob, bobClient } = await setupFixture();

      await token.mint(bob.address, 10_000_000n);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await expect(
        token.connect(bob)["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](ZeroAddress, encTransferInput),
      ).to.be.revertedWithCustomError(token, "FHERC20InvalidReceiver");
    });

    it("should handle transfer exceeding balance (transfers 0 instead)", async function () {
      const { token, bob, alice, bobClient } = await setupFixture();

      const mintValue = 1_000_000n;
      await token.mint(bob.address, mintValue);
      await token.mint(alice.address, mintValue);

      const transferValue = 10_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, alice.address);

      await token
        .connect(bob)
        ["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, encTransferInput);

      await expectFHERC20BalancesChange(token, bob.address, 0n);
      await expectFHERC20BalancesChange(token, alice.address, 0n);
    });
  });

  describe("operator management", function () {
    it("should return true when operator is set", async function () {
      const { token, bob, alice } = await setupFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      expect(await token.isOperator(bob.address, alice.address)).to.equal(true);
    });

    it("should return false when operator is not set", async function () {
      const { token, bob, alice } = await setupFixture();
      expect(await token.isOperator(bob.address, alice.address)).to.equal(false);
    });

    it("should return false when operator has expired", async function () {
      const { token, bob, alice } = await setupFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp - 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      expect(await token.isOperator(bob.address, alice.address)).to.equal(false);
    });

    it("should remove operator when setting timestamp to 0", async function () {
      const { token, bob, alice } = await setupFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);
      expect(await token.isOperator(bob.address, alice.address)).to.equal(true);

      await token.connect(bob).setOperator(alice.address, 0);
      expect(await token.isOperator(bob.address, alice.address)).to.equal(false);
    });

    it("should return true when holder is their own operator", async function () {
      const { token, bob } = await setupFixture();
      expect(await token.isOperator(bob.address, bob.address)).to.equal(true);
    });

    it("should emit OperatorSet event", async function () {
      const { token, bob, alice } = await setupFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await expect(token.connect(bob).setOperator(alice.address, timestamp))
        .to.emit(token, "OperatorSet")
        .withArgs(bob.address, alice.address, timestamp);
    });
  });

  describe("confidentialTransferFrom", function () {
    const setupTransferFromFixture = async () => {
      const { token, bob, alice, eve, aliceClient, eveClient, bobClient } = await setupFixture();

      const mintValue = 10_000_000n;
      await token.mint(bob.address, mintValue);
      await token.mint(alice.address, mintValue);

      return { token, bob, alice, eve, aliceClient, eveClient, bobClient };
    };

    it("should transfer from bob to alice (alice as operator)", async function () {
      const { token, bob, alice, aliceClient } = await setupTransferFromFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, alice.address);

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
      await expectFHERC20BalancesChange(token, alice.address, transferValue);
    });

    it("should transfer from bob to alice (eve as operator)", async function () {
      const { token, bob, alice, eve, eveClient } = await setupTransferFromFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(eve.address, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await eveClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, alice.address);

      await expect(
        token
          .connect(eve)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
      await expectFHERC20BalancesChange(token, alice.address, transferValue);
    });

    it("should transfer from bob to MockFHERC20Vault", async function () {
      const { token, bob, bobClient } = await setupTransferFromFixture();

      const vaultFactory = await ethers.getContractFactory("MockFHERC20Vault");
      const vault = await vaultFactory.deploy(token.target);
      await vault.waitForDeployment();
      const vaultAddress = await vault.getAddress();

      await token.mint(vaultAddress, 1_000_000n);

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(vaultAddress, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectFHERC20BalancesChange(token, bob.address);
      await prepExpectFHERC20BalancesChange(token, vaultAddress);

      await expect(vault.connect(bob).deposit(encTransferInput)).to.emit(token, "ConfidentialTransfer");

      await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
      await expectFHERC20BalancesChange(token, vaultAddress, transferValue);
    });

    it("should revert if invalid receiver (zero address)", async function () {
      const { token, bob, alice, aliceClient } = await setupTransferFromFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, ZeroAddress, encTransferInput),
      ).to.be.revertedWithCustomError(token, "FHERC20InvalidReceiver");
    });

    it("should revert on spender mismatch (not an operator)", async function () {
      const { token, bob, alice, eve, aliceClient } = await setupTransferFromFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(eve.address, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, alice.address, encTransferInput),
      ).to.be.revertedWithCustomError(token, "FHERC20UnauthorizedSpender");
    });
  });

  describe("confidentialTransferAndCall", function () {
    const setupTransferAndCallFixture = async () => {
      const { token, bob, alice, eve, bobClient } = await setupFixture();

      const mintValue = 10_000_000n;
      await token.mint(bob.address, mintValue);

      const receiverFactory = await ethers.getContractFactory("MockFHERC20Receiver");
      const receiver = await receiverFactory.deploy();
      await receiver.waitForDeployment();

      const transferValue = 1_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      return { token, bob, alice, eve, receiver, encTransferInput, transferValue };
    };

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

      await token.mint(alice.address, 1_000_000n);

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
      ).to.be.revertedWithCustomError(token, "FHERC20InvalidReceiver");
    });
  });

  describe("confidentialTransferFromAndCall", function () {
    const setupTransferFromAndCallFixture = async () => {
      const { token, bob, alice, eve, bobClient, aliceClient, eveClient } = await setupFixture();

      const mintValue = 10_000_000n;
      await token.mint(bob.address, mintValue);
      await token.mint(alice.address, mintValue);

      const receiverFactory = await ethers.getContractFactory("MockFHERC20Receiver");
      const receiver = await receiverFactory.deploy();
      await receiver.waitForDeployment();

      return { token, bob, alice, eve, receiver, bobClient, aliceClient, eveClient };
    };

    it("should transfer from bob to receiver with callback (as operator, success)", async function () {
      const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();

      const receiverAddress = await receiver.getAddress();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      const transferValue = 1_000_000n;
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

      const transferValue = 1_000_000n;
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

      const transferValue = 1_000_000n;
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

      const transferValue = 1_000_000n;
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
          ](bob.address, await receiver.getAddress(), encTransferInput, callData),
      ).to.be.revertedWithCustomError(token, "FHERC20UnauthorizedSpender");
    });

    it("should revert with custom error from callback", async function () {
      const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      const transferValue = 1_000_000n;
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

      const transferValue = 1_000_000n;
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
          ](bob.address, ZeroAddress, encTransferInput, "0x"),
      ).to.be.revertedWithCustomError(token, "FHERC20InvalidReceiver");
    });
  });

  describe("disclose", function () {
    it("should emit AmountDiscloseRequested on requestDiscloseEncryptedAmount", async function () {
      const { token, bob } = await setupFixture();

      await token.mint(bob.address, 1_000_000n);

      const balanceHash = await token.confidentialBalanceOf(bob.address);

      await expect(token.connect(bob).requestDiscloseEncryptedAmount(balanceHash)).to.emit(
        token,
        "AmountDiscloseRequested",
      );
    });
  });

  describe("ERC-20 indicator", function () {
    const tick = 100n;
    const base = 79_840_000n * tick;
    const transferVal = 79_840_001n * tick;

    it("should return 0 for accounts that have never interacted", async function () {
      const { token, bob } = await setupFixture();
      expect(await token.balanceOf(bob.address)).to.equal(0n);
    });

    it("should return base + 1 tick after first receive (mint)", async function () {
      const { token, bob } = await setupFixture();
      await token.mint(bob.address, 1_000_000n);
      expect(await token.balanceOf(bob.address)).to.equal(base + tick);
    });

    it("should increment on receive and decrement on send", async function () {
      const { token, bob, alice, bobClient } = await setupFixture();

      await token.mint(bob.address, 5_000_000n);
      expect(await token.balanceOf(bob.address)).to.equal(base + tick);

      const [enc] = await bobClient.encryptInputs([Encryptable.uint64(1_000_000n)]).execute();
      await token.connect(bob)["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, enc);

      expect(await token.balanceOf(bob.address)).to.equal(base);
      expect(await token.balanceOf(alice.address)).to.equal(base + tick);
    });

    it("should go below base (7983.9999) after more sends than receives", async function () {
      const { token, bob, alice, bobClient } = await setupFixture();

      await token.mint(bob.address, 5_000_000n);
      expect(await token.balanceOf(bob.address)).to.equal(base + tick);

      for (let i = 0; i < 4; i++) {
        const [enc] = await bobClient.encryptInputs([Encryptable.uint64(100_000n)]).execute();
        await token.connect(bob)["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, enc);
      }

      expect(await token.balanceOf(bob.address)).to.equal(79_839_997n * tick);
    });

    it("should emit Transfer event with 7984.0001 value", async function () {
      const { token, bob } = await setupFixture();

      await expect(token.mint(bob.address, 1_000_000n))
        .to.emit(token, "Transfer")
        .withArgs(ZeroAddress, bob.address, transferVal);
    });

    it("should track totalSupply indicator on mint and burn", async function () {
      const { token, bob } = await setupFixture();

      expect(await token.totalSupply()).to.equal(0n);

      await token.mint(bob.address, 1_000_000n);
      expect(await token.totalSupply()).to.equal(base + tick);

      await token.mint(bob.address, 1_000_000n);
      expect(await token.totalSupply()).to.equal(base + 2n * tick);

      await token.burn(bob.address, 500_000n);
      expect(await token.totalSupply()).to.equal(base + tick);
    });

    it("should report balanceOfIsIndicator as true", async function () {
      const { token } = await setupFixture();
      expect(await token.balanceOfIsIndicator()).to.equal(true);
    });

    it("should report correct indicatorTick for 6 decimals", async function () {
      const { token } = await setupFixture();
      expect(await token.indicatorTick()).to.equal(tick);
    });

    it("should reset indicated balance to 0", async function () {
      const { token, bob } = await setupFixture();

      await token.mint(bob.address, 1_000_000n);
      expect(await token.balanceOf(bob.address)).to.not.equal(0n);

      await token.connect(bob).resetIndicatedBalance();
      expect(await token.balanceOf(bob.address)).to.equal(0n);
    });

    it("should revert on ERC-20 transfer", async function () {
      const { token, bob, alice } = await setupFixture();
      await expect(token.connect(bob).transfer(alice.address, 1n)).to.be.revertedWithCustomError(
        token,
        "FHERC20IncompatibleFunction",
      );
    });

    it("should revert on ERC-20 transferFrom", async function () {
      const { token, bob, alice } = await setupFixture();
      await expect(token.connect(bob).transferFrom(bob.address, alice.address, 1n)).to.be.revertedWithCustomError(
        token,
        "FHERC20IncompatibleFunction",
      );
    });

    it("should revert on ERC-20 approve", async function () {
      const { token, bob, alice } = await setupFixture();
      await expect(token.connect(bob).approve(alice.address, 1n)).to.be.revertedWithCustomError(
        token,
        "FHERC20IncompatibleFunction",
      );
    });

    it("should revert on ERC-20 allowance", async function () {
      const { token, bob, alice } = await setupFixture();
      await expect(token.allowance(bob.address, alice.address)).to.be.revertedWithCustomError(
        token,
        "FHERC20IncompatibleFunction",
      );
    });
  });

  describe("ERC-20 indicator across decimal values", function () {
    it("should work with 18 decimals (tick = 1e14)", async function () {
      const [, bob, alice] = await ethers.getSigners();
      const bobClient = await hre.cofhe.createClientWithBatteries(bob);
      const token = await deployWithDecimals(18);

      const tick = 10n ** 14n;
      const base = 79_840_000n * tick;

      expect(await token.indicatorTick()).to.equal(tick);
      expect(await token.balanceOf(bob.address)).to.equal(0n);

      await token.mint(bob.address, 1_000_000n);
      expect(await token.balanceOf(bob.address)).to.equal(base + tick);

      const [enc] = await bobClient.encryptInputs([Encryptable.uint64(100_000n)]).execute();
      await token.connect(bob)["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, enc);

      expect(await token.balanceOf(bob.address)).to.equal(base);
      expect(await token.balanceOf(alice.address)).to.equal(base + tick);
    });

    it("should work with 6 decimals (tick = 100)", async function () {
      const [, bob] = await ethers.getSigners();
      const token = await deployWithDecimals(6);

      const tick = 100n;
      const base = 79_840_000n * tick;

      expect(await token.indicatorTick()).to.equal(tick);

      await token.mint(bob.address, 500_000n);
      expect(await token.balanceOf(bob.address)).to.equal(base + tick);
    });

    it("should work with 4 decimals (tick = 1)", async function () {
      const [, bob] = await ethers.getSigners();
      const token = await deployWithDecimals(4);

      const tick = 1n;
      const base = 79_840_000n * tick;

      expect(await token.indicatorTick()).to.equal(tick);

      await token.mint(bob.address, 500n);
      expect(await token.balanceOf(bob.address)).to.equal(base + tick);
    });

    it("should work with 2 decimals (tick = 1)", async function () {
      const [, bob] = await ethers.getSigners();
      const token = await deployWithDecimals(2);

      const tick = 1n;
      const base = 79_840_000n * tick;

      expect(await token.indicatorTick()).to.equal(tick);

      await token.mint(bob.address, 50n);
      expect(await token.balanceOf(bob.address)).to.equal(base + tick);
    });

    it("should work with 0 decimals (tick = 1)", async function () {
      const [, bob] = await ethers.getSigners();
      const token = await deployWithDecimals(0);

      expect(await token.indicatorTick()).to.equal(1n);

      await token.mint(bob.address, 1n);
      expect(await token.balanceOf(bob.address)).to.equal(79_840_001n);
    });
  });
}
