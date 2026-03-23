import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ERC7984_Harness } from "../typechain-types";
import { Encryptable } from "@cofhe/sdk";
import { prepExpectERC7984BalancesChange, expectERC7984BalancesChange } from "./utils";
import { ZeroAddress } from "ethers";

describe("ERC7984", function () {
  const deployContracts = async () => {
    const factory = await ethers.getContractFactory("ERC7984_Harness");
    const token = (await factory.deploy(
      "Test Token",
      "TST",
      6,
      "https://example.com/contract.json",
    )) as ERC7984_Harness;
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

  describe("initialization", function () {
    it("should be constructed correctly", async function () {
      const { token } = await setupFixture();

      expect(await token.name()).to.equal("Test Token");
      expect(await token.symbol()).to.equal("TST");
      expect(await token.decimals()).to.equal(6);
      expect(await token.contractURI()).to.equal("https://example.com/contract.json");
      expect(await token.confidentialTotalSupply()).to.equal(0n);
    });

    it("should support IERC7984 and ERC165 interfaces", async function () {
      const { token } = await setupFixture();

      // IERC165 interfaceId = 0x01ffc9a7
      expect(await token.supportsInterface("0x01ffc9a7")).to.equal(true);

      // IERC7984 interfaceId
      expect(await token.supportsInterface(await getIERC7984InterfaceId())).to.equal(true);

      // Random unsupported interfaceId
      expect(await token.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });

  describe("mint", function () {
    it("should mint tokens", async function () {
      const { bob, token } = await setupFixture();

      expect(await token.confidentialTotalSupply()).to.equal(0n);

      const value = 1_000_000n; // 1 token with 6 decimals

      await prepExpectERC7984BalancesChange(token, bob.address);

      await token.mint(bob.address, value);

      await expectERC7984BalancesChange(token, bob.address, value);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), value);

      // Mint again and verify cumulative balance
      await prepExpectERC7984BalancesChange(token, bob.address);

      await token.mint(bob.address, value);

      await expectERC7984BalancesChange(token, bob.address, value);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), value * 2n);
    });

    it("should revert if minting to the zero address", async function () {
      const { token } = await setupFixture();

      await expect(token.mint(ZeroAddress, 1_000_000n)).to.be.revertedWithCustomError(token, "ERC7984InvalidReceiver");
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

      await prepExpectERC7984BalancesChange(token, bob.address);

      await token.burn(bob.address, burnValue);

      await expectERC7984BalancesChange(token, bob.address, -1n * burnValue);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), mintValue - burnValue);
    });

    it("should revert if burning from the zero address", async function () {
      const { token } = await setupFixture();

      await expect(token.burn(ZeroAddress, 1_000_000n)).to.be.revertedWithCustomError(token, "ERC7984InvalidSender");
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

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, alice.address);

      await expect(
        token
          .connect(bob)
          ["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, alice.address, transferValue);
    });

    it("should revert on transfer to zero address", async function () {
      const { token, bob, bobClient } = await setupFixture();

      await token.mint(bob.address, 10_000_000n);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await expect(
        token.connect(bob)["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](ZeroAddress, encTransferInput),
      ).to.be.revertedWithCustomError(token, "ERC7984InvalidReceiver");
    });

    it("should handle transfer exceeding balance (transfers 0 instead)", async function () {
      const { token, bob, alice, bobClient } = await setupFixture();

      const mintValue = 1_000_000n;
      await token.mint(bob.address, mintValue);
      await token.mint(alice.address, mintValue);

      // Try to transfer more than balance
      const transferValue = 10_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, alice.address);

      await token
        .connect(bob)
        ["confidentialTransfer(address,(uint256,uint8,uint8,bytes))"](alice.address, encTransferInput);

      // FHESafeMath.tryDecrease fails, so transferred amount becomes 0
      await expectERC7984BalancesChange(token, bob.address, 0n);
      await expectERC7984BalancesChange(token, alice.address, 0n);
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

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, alice.address);

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, alice.address, transferValue);
    });

    it("should transfer from bob to alice (eve as operator)", async function () {
      const { token, bob, alice, eve, eveClient } = await setupTransferFromFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(eve.address, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await eveClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, alice.address);

      await expect(
        token
          .connect(eve)
          [
            "confidentialTransferFrom(address,address,(uint256,uint8,uint8,bytes))"
          ](bob.address, alice.address, encTransferInput),
      ).to.emit(token, "ConfidentialTransfer");

      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, alice.address, transferValue);
    });

    it("should transfer from bob to MockERC7984Vault", async function () {
      const { token, bob, bobClient } = await setupTransferFromFixture();

      const vaultFactory = await ethers.getContractFactory("MockERC7984Vault");
      const vault = await vaultFactory.deploy(token.target);
      await vault.waitForDeployment();
      const vaultAddress = await vault.getAddress();

      // Mint to vault so it has an initialized balance
      await token.mint(vaultAddress, 1_000_000n);

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(vaultAddress, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, vaultAddress);

      await expect(vault.connect(bob).deposit(encTransferInput)).to.emit(token, "ConfidentialTransfer");

      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, vaultAddress, transferValue);
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
      ).to.be.revertedWithCustomError(token, "ERC7984InvalidReceiver");
    });

    it("should revert on spender mismatch (not an operator)", async function () {
      const { token, bob, alice, eve, aliceClient } = await setupTransferFromFixture();

      // Set eve as operator for bob (not alice)
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
      ).to.be.revertedWithCustomError(token, "ERC7984UnauthorizedSpender");
    });
  });

  describe("confidentialTransferAndCall", function () {
    const setupTransferAndCallFixture = async () => {
      const { token, bob, alice, eve, bobClient } = await setupFixture();

      const mintValue = 10_000_000n;
      await token.mint(bob.address, mintValue);

      const receiverFactory = await ethers.getContractFactory("MockERC7984Receiver");
      const receiver = await receiverFactory.deploy();
      await receiver.waitForDeployment();

      const transferValue = 1_000_000n;
      const [encTransferInput] = await bobClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      return { token, bob, alice, eve, receiver, encTransferInput, transferValue };
    };

    it("should transfer with callback to receiver (success)", async function () {
      const { token, bob, receiver, encTransferInput, transferValue } = await setupTransferAndCallFixture();

      const receiverAddress = await receiver.getAddress();

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, receiverAddress);

      const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

      const tx = await token
        .connect(bob)
        [
          "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
        ](receiverAddress, encTransferInput, callData);

      await expect(tx).to.emit(receiver, "ConfidentialTransferCallback").withArgs(true);

      // Successful callback: transfer goes through, refund is 0
      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, receiverAddress, transferValue);
    });

    it("should transfer with callback to receiver (failure - refund)", async function () {
      const { token, bob, receiver, encTransferInput } = await setupTransferAndCallFixture();

      const receiverAddress = await receiver.getAddress();

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, receiverAddress);

      const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);

      await expect(
        token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
          ](receiverAddress, encTransferInput, callData),
      ).to.emit(receiver, "ConfidentialTransferCallback");

      // Failed callback: transfer should be refunded, balances unchanged
      await expectERC7984BalancesChange(token, bob.address, 0n);
      await expectERC7984BalancesChange(token, receiverAddress, 0n);
    });

    it("should transfer with callback to EOA (always succeeds)", async function () {
      const { token, bob, alice, encTransferInput, transferValue } = await setupTransferAndCallFixture();

      await token.mint(alice.address, 1_000_000n);

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, alice.address);

      const tx = await token
        .connect(bob)
        [
          "confidentialTransferAndCall(address,(uint256,uint8,uint8,bytes),bytes)"
        ](alice.address, encTransferInput, "0x");

      await expect(tx).to.emit(token, "ConfidentialTransfer");

      // EOA always returns success, so transfer goes through
      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, alice.address, transferValue);
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
      ).to.be.revertedWithCustomError(token, "ERC7984InvalidReceiver");
    });
  });

  describe("confidentialTransferFromAndCall", function () {
    const setupTransferFromAndCallFixture = async () => {
      const { token, bob, alice, eve, bobClient, aliceClient, eveClient } = await setupFixture();

      const mintValue = 10_000_000n;
      await token.mint(bob.address, mintValue);
      await token.mint(alice.address, mintValue);

      const receiverFactory = await ethers.getContractFactory("MockERC7984Receiver");
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

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, receiverAddress);

      const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

      const tx = await token
        .connect(alice)
        [
          "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
        ](bob.address, receiverAddress, encTransferInput, callData);

      await expect(tx).to.emit(receiver, "ConfidentialTransferCallback").withArgs(true);

      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, receiverAddress, transferValue);
    });

    it("should transfer from bob to receiver with callback (failure - refund)", async function () {
      const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();

      const receiverAddress = await receiver.getAddress();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await aliceClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, receiverAddress);

      const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
          ](bob.address, receiverAddress, encTransferInput, callData),
      ).to.emit(receiver, "ConfidentialTransferCallback");

      // Failed callback: transfer should be refunded, balances unchanged
      await expectERC7984BalancesChange(token, bob.address, 0n);
      await expectERC7984BalancesChange(token, receiverAddress, 0n);
    });

    it("should transfer from bob to alice (EOA) with callback via eve as operator", async function () {
      const { token, bob, alice, eve, eveClient } = await setupTransferFromAndCallFixture();

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(eve.address, timestamp);

      const transferValue = 1_000_000n;
      const [encTransferInput] = await eveClient.encryptInputs([Encryptable.uint64(transferValue)]).execute();

      await prepExpectERC7984BalancesChange(token, bob.address);
      await prepExpectERC7984BalancesChange(token, alice.address);

      const tx = await token
        .connect(eve)
        [
          "confidentialTransferFromAndCall(address,address,(uint256,uint8,uint8,bytes),bytes)"
        ](bob.address, alice.address, encTransferInput, "0x");

      await expect(tx).to.emit(token, "ConfidentialTransfer");

      await expectERC7984BalancesChange(token, bob.address, -1n * transferValue);
      await expectERC7984BalancesChange(token, alice.address, transferValue);
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
      ).to.be.revertedWithCustomError(token, "ERC7984UnauthorizedSpender");
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
      ).to.be.revertedWithCustomError(token, "ERC7984InvalidReceiver");
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
});

async function getIERC7984InterfaceId(): Promise<string> {
  const selectors = [
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
  ];

  let interfaceId = 0n;
  for (const sig of selectors) {
    const hash = ethers.keccak256(ethers.toUtf8Bytes(sig));
    const selector = BigInt(hash.slice(0, 10));
    interfaceId ^= selector;
  }

  return "0x" + interfaceId.toString(16).padStart(8, "0");
}
