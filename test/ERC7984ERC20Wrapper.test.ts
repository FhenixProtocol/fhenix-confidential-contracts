import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ERC7984ERC20Wrapper_Harness, ERC20_Harness } from "../typechain-types";
import { Encryptable } from "@cofhe/sdk";
import {
  expectERC20BalancesChange,
  expectERC7984BalancesChange,
  prepExpectERC20BalancesChange,
  prepExpectERC7984BalancesChange,
} from "./utils";
import { ZeroAddress, ContractTransactionResponse } from "ethers";

async function getUnshieldRequestId(
  tx: ContractTransactionResponse,
  contract: ERC7984ERC20Wrapper_Harness,
): Promise<string> {
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "Unshielded") {
        return parsed.args.unshieldRequestId;
      }
    } catch {}
  }
  throw new Error("Unshielded event not found");
}

describe("ERC7984ERC20Wrapper", function () {
  const deployContracts = async () => {
    const wBTCFactory = await ethers.getContractFactory("ERC20_Harness");
    const wBTC = (await wBTCFactory.deploy("Wrapped BTC", "wBTC", 8)) as ERC20_Harness;
    await wBTC.waitForDeployment();

    const eBTCFactory = await ethers.getContractFactory("ERC7984ERC20Wrapper_Harness");
    const eBTC = (await eBTCFactory.deploy(
      wBTC.target,
      "ERC7984 Wrapped BTC",
      "eBTC",
      "https://example.com/ebtc.json",
    )) as ERC7984ERC20Wrapper_Harness;
    await eBTC.waitForDeployment();

    return { wBTC, eBTC };
  };

  async function setupFixture() {
    const [owner, bob, alice, eve] = await ethers.getSigners();
    const { wBTC, eBTC } = await deployContracts();

    const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const eveClient = await hre.cofhe.createClientWithBatteries(eve);

    return { ownerClient, bobClient, aliceClient, eveClient, owner, bob, alice, eve, wBTC, eBTC };
  }

  // wBTC has 8 decimals → rate = 100, confidential decimals = 6
  const conversionRate = 100n;

  describe("initialization", function () {
    it("should be constructed correctly", async function () {
      const { wBTC, eBTC } = await setupFixture();

      expect(await eBTC.name()).to.equal("ERC7984 Wrapped BTC");
      expect(await eBTC.symbol()).to.equal("eBTC");
      expect(await eBTC.decimals()).to.equal(6);
      expect(await eBTC.contractURI()).to.equal("https://example.com/ebtc.json");
      expect(await eBTC.underlying()).to.equal(wBTC.target);
      expect(await eBTC.rate()).to.equal(conversionRate);
      expect(await eBTC.maxTotalSupply()).to.equal(BigInt("18446744073709551615")); // type(uint64).max
      expect(await eBTC.inferredTotalSupply()).to.equal(0n);
    });

    it("should support expected interfaces", async function () {
      const { eBTC } = await setupFixture();

      // ERC165
      expect(await eBTC.supportsInterface("0x01ffc9a7")).to.equal(true);
      // IERC1363Receiver
      expect(await eBTC.supportsInterface("0x88a7ca5c")).to.equal(true);
      // Random unsupported
      expect(await eBTC.supportsInterface("0xdeadbeef")).to.equal(false);
    });

    it("should allow symbol update", async function () {
      const { eBTC } = await setupFixture();

      await expect(eBTC.updateSymbol("encBTC")).to.emit(eBTC, "SymbolUpdated").withArgs("encBTC");
      expect(await eBTC.symbol()).to.equal("encBTC");
    });
  });

  describe("shield (ERC20 → ERC7984)", function () {
    it("should shield tokens successfully", async function () {
      const { eBTC, bob, wBTC } = await setupFixture();

      const mintValue = BigInt(10e8);
      const shieldValue = BigInt(1e8);
      const confidentialValue = shieldValue / conversionRate; // 1e6

      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);

      await prepExpectERC20BalancesChange(wBTC, bob.address);
      await prepExpectERC7984BalancesChange(eBTC, bob.address);

      await expect(eBTC.connect(bob).shield(bob, shieldValue)).to.emit(eBTC, "ConfidentialTransfer");

      await expectERC20BalancesChange(wBTC, bob.address, -1n * shieldValue);
      await expectERC7984BalancesChange(eBTC, bob.address, confidentialValue);

      await hre.cofhe.mocks.expectPlaintext(await eBTC.confidentialTotalSupply(), confidentialValue);
      expect(await eBTC.inferredTotalSupply()).to.equal(confidentialValue);
    });

    it("should shield to a different recipient", async function () {
      const { eBTC, bob, alice, wBTC } = await setupFixture();

      const shieldValue = BigInt(1e8);
      const confidentialValue = shieldValue / conversionRate;

      await wBTC.mint(bob, shieldValue);
      await wBTC.connect(bob).approve(eBTC.target, shieldValue);

      await prepExpectERC7984BalancesChange(eBTC, alice.address);

      await eBTC.connect(bob).shield(alice, shieldValue);

      await expectERC7984BalancesChange(eBTC, alice.address, confidentialValue);
    });

    it("should truncate amount to nearest rate multiple", async function () {
      const { eBTC, bob, wBTC } = await setupFixture();

      const shieldValue = BigInt(1e8) + 50n; // 50 extra (below rate of 100)
      const alignedValue = BigInt(1e8);
      const confidentialValue = alignedValue / conversionRate;

      await wBTC.mint(bob, shieldValue);
      await wBTC.connect(bob).approve(eBTC.target, shieldValue);

      await prepExpectERC20BalancesChange(wBTC, bob.address);
      await prepExpectERC7984BalancesChange(eBTC, bob.address);

      await eBTC.connect(bob).shield(bob, shieldValue);

      // Only the aligned portion is transferred
      await expectERC20BalancesChange(wBTC, bob.address, -1n * alignedValue);
      await expectERC7984BalancesChange(eBTC, bob.address, confidentialValue);
    });

    it("should shield cumulatively", async function () {
      const { eBTC, bob, wBTC } = await setupFixture();

      const shieldValue = BigInt(1e8);
      const confidentialValue = shieldValue / conversionRate;

      await wBTC.mint(bob, BigInt(10e8));
      await wBTC.connect(bob).approve(eBTC.target, BigInt(10e8));

      await eBTC.connect(bob).shield(bob, shieldValue);

      await prepExpectERC7984BalancesChange(eBTC, bob.address);

      await eBTC.connect(bob).shield(bob, shieldValue);

      await expectERC7984BalancesChange(eBTC, bob.address, confidentialValue);
      await hre.cofhe.mocks.expectPlaintext(await eBTC.confidentialTotalSupply(), confidentialValue * 2n);
    });
  });

  describe("unshield & claimUnshielded (ERC7984 → ERC20)", function () {
    async function setupShieldedFixture() {
      const fixture = await setupFixture();
      const { eBTC, bob, wBTC } = fixture;

      const mintValue = BigInt(10e8);
      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);
      await eBTC.connect(bob).shield(bob, mintValue);

      return fixture;
    }

    it("should complete unshield and claim flow", async function () {
      const { eBTC, bob, alice, wBTC, bobClient } = await setupShieldedFixture();

      const unshieldConfidentialValue = 1_000_000n;
      const unshieldERC20Value = unshieldConfidentialValue * conversionRate; // 1e8

      const [encAmount] = await bobClient.encryptInputs([Encryptable.uint64(unshieldConfidentialValue)]).execute();

      await prepExpectERC7984BalancesChange(eBTC, bob.address);

      const tx = await eBTC
        .connect(bob)
        ["unshield(address,address,(uint256,uint8,uint8,bytes))"](bob.address, alice.address, encAmount);

      await expect(tx).to.emit(eBTC, "Unshielded");
      await expectERC7984BalancesChange(eBTC, bob.address, -1n * unshieldConfidentialValue);

      const unshieldRequestId = await getUnshieldRequestId(tx, eBTC);

      expect(await eBTC.unshieldRequester(unshieldRequestId)).to.equal(alice.address);

      // Time travel past decryption delay
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(unshieldRequestId).withoutPermit().execute();

      await prepExpectERC20BalancesChange(wBTC, alice.address);

      await expect(
        eBTC.connect(bob).claimUnshielded(unshieldRequestId, decryption.decryptedValue, decryption.signature),
      ).to.emit(eBTC, "ClaimedUnshielded");

      await expectERC20BalancesChange(wBTC, alice.address, unshieldERC20Value);

      // Request is cleared
      expect(await eBTC.unshieldRequester(unshieldRequestId)).to.equal(ZeroAddress);
    });

    it("should allow unshield by operator", async function () {
      const { eBTC, bob, alice, wBTC, aliceClient } = await setupShieldedFixture();

      const unshieldConfidentialValue = 1_000_000n;
      const unshieldERC20Value = unshieldConfidentialValue * conversionRate;

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await eBTC.connect(bob).setOperator(alice.address, timestamp);

      const [encAmount] = await aliceClient.encryptInputs([Encryptable.uint64(unshieldConfidentialValue)]).execute();

      await prepExpectERC7984BalancesChange(eBTC, bob.address);

      const tx = await eBTC
        .connect(alice)
        ["unshield(address,address,(uint256,uint8,uint8,bytes))"](bob.address, alice.address, encAmount);

      await expect(tx).to.emit(eBTC, "Unshielded");
      await expectERC7984BalancesChange(eBTC, bob.address, -1n * unshieldConfidentialValue);

      const unshieldRequestId = await getUnshieldRequestId(tx, eBTC);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await aliceClient.decryptForTx(unshieldRequestId).withoutPermit().execute();

      await prepExpectERC20BalancesChange(wBTC, alice.address);

      await eBTC.connect(alice).claimUnshielded(unshieldRequestId, decryption.decryptedValue, decryption.signature);

      await expectERC20BalancesChange(wBTC, alice.address, unshieldERC20Value);
    });
  });

  describe("unshield reverts", function () {
    it("should revert on zero address receiver", async function () {
      const { eBTC, bob, wBTC, bobClient } = await setupFixture();

      const mintValue = BigInt(10e8);
      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);
      await eBTC.connect(bob).shield(bob, mintValue);

      const [encAmount] = await bobClient.encryptInputs([Encryptable.uint64(1_000_000n)]).execute();

      await expect(
        eBTC
          .connect(bob)
          ["unshield(address,address,(uint256,uint8,uint8,bytes))"](bob.address, ZeroAddress, encAmount),
      ).to.be.revertedWithCustomError(eBTC, "ERC7984InvalidReceiver");
    });

    it("should revert when caller is not operator", async function () {
      const { eBTC, bob, alice, wBTC, aliceClient } = await setupFixture();

      const mintValue = BigInt(10e8);
      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);
      await eBTC.connect(bob).shield(bob, mintValue);

      const [encAmount] = await aliceClient.encryptInputs([Encryptable.uint64(1_000_000n)]).execute();

      await expect(
        eBTC
          .connect(alice)
          ["unshield(address,address,(uint256,uint8,uint8,bytes))"](bob.address, alice.address, encAmount),
      ).to.be.revertedWithCustomError(eBTC, "ERC7984UnauthorizedSpender");
    });
  });

  describe("claimUnshielded reverts", function () {
    it("should revert on invalid request id", async function () {
      const { eBTC } = await setupFixture();

      await expect(
        eBTC.claimUnshielded(ethers.ZeroHash, 0n, new Uint8Array(0)),
      ).to.be.revertedWithCustomError(eBTC, "InvalidUnshieldRequest");
    });
  });

  describe("onTransferReceived", function () {
    it("should revert when called by non-underlying token", async function () {
      const { eBTC, bob } = await setupFixture();

      await expect(
        eBTC.connect(bob).onTransferReceived(bob.address, bob.address, 1000n, "0x"),
      ).to.be.revertedWithCustomError(eBTC, "ERC7984UnauthorizedCaller");
    });
  });
});
