import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { FHERC20NativeWrapper_Harness, WETH_Harness } from "../typechain-types";
import { expectFHERC20BalancesChange, prepExpectFHERC20BalancesChange } from "./utils";
import { ZeroAddress, ContractTransactionResponse } from "ethers";
import { getIFHERC20NativeWrapperInterfaceId } from "./FHERC20.behavior";

// The unshield flow involves TWO distinct identifiers (they used to coincide when claims were
// keyed by the ciphertext handle):
//  - `ctHash`  — the burned handle from the Unshielded event; the DECRYPTION target.
//  - `claimId` — the unique per-claimant claim key; what claimUnshielded/getClaim take.
async function getUnshieldRequest(
  tx: ContractTransactionResponse,
  contract: FHERC20NativeWrapper_Harness,
  recipient: string,
): Promise<{ ctHash: string; claimId: string }> {
  const receipt = await tx.wait();
  let ctHash: string | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "Unshielded") {
        ctHash = parsed.args.amount;
      }
    } catch {}
  }
  if (ctHash === undefined) throw new Error("Unshielded event not found");

  const claims = await contract.getUserClaims(recipient);
  const claim = claims.find(c => !c.claimed && BigInt(c.ctHash) === BigInt(ctHash!));
  if (!claim) throw new Error("pending claim for unshield not found");
  return { ctHash, claimId: claim.id };
}

// The wrappers delegate claim bookkeeping to the external ERC20ConfidentialLib — link it.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

describe("FHERC20NativeWrapper", function () {
  const deployContracts = async () => {
    const wETHFactory = await ethers.getContractFactory("WETH_Harness");
    const wETH = (await wETHFactory.deploy()) as WETH_Harness;
    await wETH.waitForDeployment();

    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const eETHFactory = await ethers.getContractFactory("FHERC20NativeWrapper_Harness", {
      libraries: { [LIB_FQN]: await lib.getAddress() },
    });
    const eETH = (await eETHFactory.deploy(
      wETH.target,
      "FHERC20 Wrapped ETH",
      "eETH",
      "https://example.com/eeth.json",
    )) as FHERC20NativeWrapper_Harness;
    await eETH.waitForDeployment();

    return { wETH, eETH };
  };

  async function setupFixture() {
    const [owner, bob, alice, eve] = await ethers.getSigners();
    const { wETH, eETH } = await deployContracts();

    const ownerClient = await hre.cofhe.createClientWithBatteries(owner);
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    const aliceClient = await hre.cofhe.createClientWithBatteries(alice);
    const eveClient = await hre.cofhe.createClientWithBatteries(eve);

    return { ownerClient, bobClient, aliceClient, eveClient, owner, bob, alice, eve, wETH, eETH };
  }

  // wETH has 18 decimals → rate = 1e12, confidential decimals = 6
  const conversionRate = 1_000_000_000_000n; // 1e12

  describe("initialization", function () {
    it("should be constructed correctly", async function () {
      const { wETH, eETH } = await setupFixture();

      expect(await eETH.name()).to.equal("FHERC20 Wrapped ETH");
      expect(await eETH.symbol()).to.equal("eETH");
      expect(await eETH.decimals()).to.equal(6);
      expect(await eETH.contractURI()).to.equal("https://example.com/eeth.json");
      expect(await eETH.weth()).to.equal(wETH.target);
      expect(await eETH.rate()).to.equal(conversionRate);
      expect(await eETH.maxTotalSupply()).to.equal(BigInt("18446744073709551615"));
      expect(await eETH.inferredTotalSupply()).to.equal(0n);
    });

    it("should support expected interfaces", async function () {
      const { eETH } = await setupFixture();

      // ERC165
      expect(await eETH.supportsInterface("0x01ffc9a7")).to.equal(true);
      // IFHERC20NativeWrapper
      expect(await eETH.supportsInterface(getIFHERC20NativeWrapperInterfaceId())).to.equal(true);
      // Random unsupported
      expect(await eETH.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });

  describe("shieldWrappedNative (WETH → FHERC20)", function () {
    it("should shield WETH successfully", async function () {
      const { eETH, bob, wETH } = await setupFixture();

      const mintValue = ethers.parseEther("10");
      const shieldValue = ethers.parseEther("1");
      const confidentialValue = shieldValue / conversionRate; // 1e6

      await wETH.connect(bob).deposit({ value: mintValue });
      await wETH.connect(bob).approve(eETH.target, mintValue);

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      await expect(eETH.connect(bob).shieldWrappedNative(bob, shieldValue)).to.emit(eETH, "ShieldedNative");

      await expectFHERC20BalancesChange(eETH, bob.address, confidentialValue);
      await hre.cofhe.mocks.expectPlaintext(await eETH.confidentialTotalSupply(), confidentialValue);
    });

    it("should shield WETH to a different recipient", async function () {
      const { eETH, bob, alice, wETH } = await setupFixture();

      const shieldValue = ethers.parseEther("1");
      const confidentialValue = shieldValue / conversionRate;

      await wETH.connect(bob).deposit({ value: shieldValue });
      await wETH.connect(bob).approve(eETH.target, shieldValue);

      await prepExpectFHERC20BalancesChange(eETH, alice.address);

      await eETH.connect(bob).shieldWrappedNative(alice, shieldValue);

      await expectFHERC20BalancesChange(eETH, alice.address, confidentialValue);
    });

    it("should truncate amount to rate multiple", async function () {
      const { eETH, bob, wETH } = await setupFixture();

      const shieldValue = ethers.parseEther("1") + (conversionRate - 1n);
      const alignedValue = ethers.parseEther("1");
      const confidentialValue = alignedValue / conversionRate;

      await wETH.connect(bob).deposit({ value: shieldValue });
      await wETH.connect(bob).approve(eETH.target, shieldValue);

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      await eETH.connect(bob).shieldWrappedNative(bob, shieldValue);

      await expectFHERC20BalancesChange(eETH, bob.address, confidentialValue);
    });

    it("should revert when amount too small for confidential precision", async function () {
      const { eETH, bob, wETH } = await setupFixture();

      const dust = conversionRate - 1n;
      await wETH.connect(bob).deposit({ value: dust });
      await wETH.connect(bob).approve(eETH.target, dust);

      await expect(eETH.connect(bob).shieldWrappedNative(bob, dust)).to.be.revertedWithCustomError(
        eETH,
        "AmountTooSmallForConfidentialPrecision",
      );
    });

    it("should default to msg.sender when to is zero address", async function () {
      const { eETH, bob, wETH } = await setupFixture();

      const shieldValue = ethers.parseEther("1");
      const confidentialValue = shieldValue / conversionRate;

      await wETH.connect(bob).deposit({ value: shieldValue });
      await wETH.connect(bob).approve(eETH.target, shieldValue);

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      await eETH.connect(bob).shieldWrappedNative(ZeroAddress, shieldValue);

      await expectFHERC20BalancesChange(eETH, bob.address, confidentialValue);
    });
  });

  describe("shieldNative (ETH → FHERC20)", function () {
    it("should shield native ETH successfully", async function () {
      const { eETH, bob } = await setupFixture();

      const shieldValue = ethers.parseEther("1");
      const confidentialValue = shieldValue / conversionRate;

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      await expect(eETH.connect(bob).shieldNative(bob, { value: shieldValue })).to.emit(eETH, "ShieldedNative");

      await expectFHERC20BalancesChange(eETH, bob.address, confidentialValue);
      await hre.cofhe.mocks.expectPlaintext(await eETH.confidentialTotalSupply(), confidentialValue);
    });

    it("should refund dust below conversion rate", async function () {
      const { eETH, bob } = await setupFixture();

      const alignedValue = ethers.parseEther("1");
      const dust = conversionRate - 1n;
      const totalSent = alignedValue + dust;
      const confidentialValue = alignedValue / conversionRate;

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      await eETH.connect(bob).shieldNative(bob, { value: totalSent });

      await expectFHERC20BalancesChange(eETH, bob.address, confidentialValue);
    });

    it("should revert when amount too small for confidential precision", async function () {
      const { eETH, bob } = await setupFixture();

      const dust = conversionRate - 1n;

      await expect(eETH.connect(bob).shieldNative(bob, { value: dust })).to.be.revertedWithCustomError(
        eETH,
        "AmountTooSmallForConfidentialPrecision",
      );
    });

    it("should default to msg.sender when to is zero address", async function () {
      const { eETH, bob } = await setupFixture();

      const shieldValue = ethers.parseEther("1");
      const confidentialValue = shieldValue / conversionRate;

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      await eETH.connect(bob).shieldNative(ZeroAddress, { value: shieldValue });

      await expectFHERC20BalancesChange(eETH, bob.address, confidentialValue);
    });
  });

  describe("unshield & claimUnshielded (FHERC20 → ETH)", function () {
    async function setupShieldedFixture() {
      const fixture = await setupFixture();
      const { eETH, bob } = fixture;

      const mintValue = ethers.parseEther("10");
      await eETH.connect(bob).shieldNative(bob, { value: mintValue });

      return fixture;
    }

    it("should complete unshield and claim flow", async function () {
      const { eETH, bob, alice, bobClient } = await setupShieldedFixture();

      const unshieldConfidentialValue = 1_000_000n;
      const unshieldNativeValue = unshieldConfidentialValue * conversionRate; // 1e18

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      const tx = await eETH
        .connect(bob)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldConfidentialValue);

      await expect(tx).to.emit(eETH, "Unshielded");
      await expectFHERC20BalancesChange(eETH, bob.address, -1n * unshieldConfidentialValue);

      const { ctHash, claimId } = await getUnshieldRequest(tx, eETH, alice.address);

      // Verify claim was created via getClaim (keyed by the unique claim id)
      const pendingClaim = await eETH.getClaim(claimId);
      expect(pendingClaim.to).to.equal(alice.address);
      expect(pendingClaim.claimed).to.equal(false);

      // Verify getUserClaims tracks the pending claim (the burned handle is kept as ctHash)
      const aliceClaims = await eETH.getUserClaims(alice.address);
      expect(aliceClaims.length).to.equal(1);
      expect(BigInt(aliceClaims[0].ctHash)).to.equal(BigInt(ctHash));

      // Time travel past decryption delay
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);

      await expect(eETH.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature)).to.emit(
        eETH,
        "ClaimedUnshielded",
      );

      const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(unshieldNativeValue);

      // Claim is marked as claimed and removed from user's pending claims
      const claimedClaim = await eETH.getClaim(claimId);
      expect(claimedClaim.claimed).to.equal(true);

      const aliceClaimsAfter = await eETH.getUserClaims(alice.address);
      expect(aliceClaimsAfter.length).to.equal(0);
    });

    it("should allow unshield by operator", async function () {
      const { eETH, bob, alice, aliceClient } = await setupShieldedFixture();

      const unshieldConfidentialValue = 1_000_000n;
      const unshieldNativeValue = unshieldConfidentialValue * conversionRate;

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await eETH.connect(bob).setOperator(alice.address, timestamp);

      await prepExpectFHERC20BalancesChange(eETH, bob.address);

      const tx = await eETH
        .connect(alice)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldConfidentialValue);

      await expect(tx).to.emit(eETH, "Unshielded");
      await expectFHERC20BalancesChange(eETH, bob.address, -1n * unshieldConfidentialValue);

      const { ctHash, claimId } = await getUnshieldRequest(tx, eETH, alice.address);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await aliceClient.decryptForTx(ctHash).withoutACP().execute();

      const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);

      await eETH.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

      const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(unshieldNativeValue);
    });

    it("should support batch claim", async function () {
      const { eETH, bob, alice, bobClient } = await setupShieldedFixture();

      const unshieldAmount1 = 500_000n;
      const unshieldAmount2 = 300_000n;

      // Create first unshield
      const tx1 = await eETH
        .connect(bob)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldAmount1);
      const request1 = await getUnshieldRequest(tx1, eETH, alice.address);

      // Create second unshield
      const tx2 = await eETH
        .connect(bob)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldAmount2);
      const request2 = await getUnshieldRequest(tx2, eETH, alice.address);

      // Alice should have 2 pending claims
      const pendingClaims = await eETH.getUserClaims(alice.address);
      expect(pendingClaims.length).to.equal(2);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const dec1 = await bobClient.decryptForTx(request1.ctHash).withoutACP().execute();
      const dec2 = await bobClient.decryptForTx(request2.ctHash).withoutACP().execute();

      const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);

      await eETH
        .connect(bob)
        .claimUnshieldedBatch(
          [request1.claimId, request2.claimId],
          [dec1.decryptedValue, dec2.decryptedValue],
          [dec1.signature, dec2.signature],
        );

      const totalNativeValue = (unshieldAmount1 + unshieldAmount2) * conversionRate;
      const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(totalNativeValue);

      // All claims cleared
      const claimsAfter = await eETH.getUserClaims(alice.address);
      expect(claimsAfter.length).to.equal(0);
    });

    it("should complete unshield and claim flow with encrypted amount (sharedEuint64)", async function () {
      const { eETH, bob, alice, bobClient } = await setupFixture();

      // The bytes32 overload now takes a `sharedEuint64`, and only a contract can produce one:
      // sharing goes through FHE.shareEuint64, which an EOA cannot call. A composing contract
      // holds the confidential balance and shares it with the wrapper.
      const caller = await (await ethers.getContractFactory("MockSharedAmountCaller")).deploy();
      const callerAddr = await caller.getAddress();

      const unshieldConfidentialValue = 1_000_000n;
      const unshieldNativeValue = unshieldConfidentialValue * conversionRate; // 1e18

      // Shield exactly the unshield amount into the helper so its balance handle matches.
      await eETH.connect(bob).shieldNative(callerAddr, { value: unshieldNativeValue });

      await prepExpectFHERC20BalancesChange(eETH, callerAddr);

      const tx = await caller.unshieldOwnBalanceOnWrapper(await eETH.getAddress(), alice.address);

      await expect(tx).to.emit(eETH, "Unshielded");
      await expectFHERC20BalancesChange(eETH, callerAddr, -1n * unshieldConfidentialValue);

      const { ctHash, claimId } = await getUnshieldRequest(tx, eETH, alice.address);

      // Verify claim was created via getClaim (keyed by the unique claim id)
      const pendingClaim = await eETH.getClaim(claimId);
      expect(pendingClaim.to).to.equal(alice.address);
      expect(pendingClaim.decryptedAmount).to.equal(0n);
      expect(pendingClaim.claimed).to.equal(false);

      // Verify getUserClaims tracks the pending claim (the burned handle is kept as ctHash)
      const aliceClaims = await eETH.getUserClaims(alice.address);
      expect(aliceClaims.length).to.equal(1);
      expect(BigInt(aliceClaims[0].ctHash)).to.equal(BigInt(ctHash));

      // Time travel past decryption delay
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);

      await expect(eETH.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature)).to.emit(
        eETH,
        "ClaimedUnshielded",
      );

      const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(unshieldNativeValue);

      // Claim is marked as claimed and removed from user's pending claims
      const claimedClaim = await eETH.getClaim(claimId);
      expect(claimedClaim.claimed).to.equal(true);

      const aliceClaimsAfter = await eETH.getUserClaims(alice.address);
      expect(aliceClaimsAfter.length).to.equal(0);
    });
  });

  describe("unshield reverts", function () {
    it("should revert on zero address receiver", async function () {
      const { eETH, bob } = await setupFixture();

      await eETH.connect(bob).shieldNative(bob, { value: ethers.parseEther("10") });

      await expect(
        eETH.connect(bob)["unshield(address,address,uint64)"](bob.address, ZeroAddress, 1_000_000n),
      ).to.be.revertedWithCustomError(eETH, "FHERC20InvalidReceiver");
    });

    it("should revert when caller is not operator", async function () {
      const { eETH, bob, alice } = await setupFixture();

      await eETH.connect(bob).shieldNative(bob, { value: ethers.parseEther("10") });

      await expect(
        eETH.connect(alice)["unshield(address,address,uint64)"](bob.address, alice.address, 1_000_000n),
      ).to.be.revertedWithCustomError(eETH, "FHERC20UnauthorizedSpender");
    });
  });

  describe("claimUnshielded reverts", function () {
    it("should revert on invalid request id", async function () {
      const { eETH } = await setupFixture();

      await expect(eETH.claimUnshielded(ethers.ZeroHash, 0n, new Uint8Array(0))).to.be.revertedWithCustomError(
        eETH,
        "ClaimNotFound",
      );
    });

    it("should revert when claiming already claimed request", async function () {
      const { eETH, bob, alice, bobClient } = await setupFixture();

      await eETH.connect(bob).shieldNative(bob, { value: ethers.parseEther("10") });

      const tx = await eETH.connect(bob)["unshield(address,address,uint64)"](bob.address, alice.address, 1_000_000n);
      const { ctHash, claimId } = await getUnshieldRequest(tx, eETH, alice.address);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      // First claim succeeds
      await eETH.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

      // Second claim reverts
      await expect(
        eETH.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature),
      ).to.be.revertedWithCustomError(eETH, "AlreadyClaimed");
    });
  });
});
