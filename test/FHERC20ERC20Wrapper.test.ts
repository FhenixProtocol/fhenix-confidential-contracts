import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { FHERC20ERC20Wrapper_Harness, ERC20_Harness } from "../typechain-types";
import {
  expectERC20BalancesChange,
  expectFHERC20BalancesChange,
  prepExpectERC20BalancesChange,
  prepExpectFHERC20BalancesChange,
} from "./utils";
import { ZeroAddress, ContractTransactionResponse } from "ethers";
import { getIFHERC20ERC20WrapperInterfaceId } from "./FHERC20.behavior";

// The unshield flow involves TWO distinct identifiers (they used to coincide when claims were
// keyed by the ciphertext handle):
//  - `ctHash`  — the burned handle from the Unshielded event; the DECRYPTION target.
//  - `claimId` — the unique per-claimant claim key; what claimUnshielded/getClaim take.
async function getUnshieldRequest(
  tx: ContractTransactionResponse,
  contract: FHERC20ERC20Wrapper_Harness,
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

describe("FHERC20ERC20Wrapper", function () {
  const deployContracts = async () => {
    const wBTCFactory = await ethers.getContractFactory("ERC20_Harness");
    const wBTC = (await wBTCFactory.deploy("Wrapped BTC", "wBTC", 8)) as ERC20_Harness;
    await wBTC.waitForDeployment();

    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const eBTCFactory = await ethers.getContractFactory("FHERC20ERC20Wrapper_Harness", {
      libraries: { [LIB_FQN]: await lib.getAddress() },
    });
    const eBTC = (await eBTCFactory.deploy(
      wBTC.target,
      "FHERC20 Wrapped BTC",
      "eBTC",
      "https://example.com/ebtc.json",
    )) as FHERC20ERC20Wrapper_Harness;
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

      expect(await eBTC.name()).to.equal("FHERC20 Wrapped BTC");
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
      // IFHERC20ERC20Wrapper
      expect(await eBTC.supportsInterface(getIFHERC20ERC20WrapperInterfaceId())).to.equal(true);
      // IERC1363Receiver
      expect(await eBTC.supportsInterface("0x88a7ca5c")).to.equal(true);
      // Random unsupported
      expect(await eBTC.supportsInterface("0xdeadbeef")).to.equal(false);
    });
  });

  describe("shield (ERC20 → FHERC20)", function () {
    it("should shield tokens successfully", async function () {
      const { eBTC, bob, wBTC } = await setupFixture();

      const mintValue = BigInt(10e8);
      const shieldValue = BigInt(1e8);
      const confidentialValue = shieldValue / conversionRate; // 1e6

      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);

      await prepExpectERC20BalancesChange(wBTC, bob.address);
      await prepExpectFHERC20BalancesChange(eBTC, bob.address);

      await expect(eBTC.connect(bob).shield(bob, shieldValue)).to.emit(eBTC, "ConfidentialTransfer");

      await expectERC20BalancesChange(wBTC, bob.address, -1n * shieldValue);
      await expectFHERC20BalancesChange(eBTC, bob.address, confidentialValue);

      await hre.cofhe.mocks.expectPlaintext(await eBTC.confidentialTotalSupply(), confidentialValue);
      expect(await eBTC.inferredTotalSupply()).to.equal(confidentialValue);
    });

    it("should shield to a different recipient", async function () {
      const { eBTC, bob, alice, wBTC } = await setupFixture();

      const shieldValue = BigInt(1e8);
      const confidentialValue = shieldValue / conversionRate;

      await wBTC.mint(bob, shieldValue);
      await wBTC.connect(bob).approve(eBTC.target, shieldValue);

      await prepExpectFHERC20BalancesChange(eBTC, alice.address);

      await eBTC.connect(bob).shield(alice, shieldValue);

      await expectFHERC20BalancesChange(eBTC, alice.address, confidentialValue);
    });

    it("should truncate amount to nearest rate multiple", async function () {
      const { eBTC, bob, wBTC } = await setupFixture();

      const shieldValue = BigInt(1e8) + 50n; // 50 extra (below rate of 100)
      const alignedValue = BigInt(1e8);
      const confidentialValue = alignedValue / conversionRate;

      await wBTC.mint(bob, shieldValue);
      await wBTC.connect(bob).approve(eBTC.target, shieldValue);

      await prepExpectERC20BalancesChange(wBTC, bob.address);
      await prepExpectFHERC20BalancesChange(eBTC, bob.address);

      await eBTC.connect(bob).shield(bob, shieldValue);

      // Only the aligned portion is transferred
      await expectERC20BalancesChange(wBTC, bob.address, -1n * alignedValue);
      await expectFHERC20BalancesChange(eBTC, bob.address, confidentialValue);
    });

    it("should shield cumulatively", async function () {
      const { eBTC, bob, wBTC } = await setupFixture();

      const shieldValue = BigInt(1e8);
      const confidentialValue = shieldValue / conversionRate;

      await wBTC.mint(bob, BigInt(10e8));
      await wBTC.connect(bob).approve(eBTC.target, BigInt(10e8));

      await eBTC.connect(bob).shield(bob, shieldValue);

      await prepExpectFHERC20BalancesChange(eBTC, bob.address);

      await eBTC.connect(bob).shield(bob, shieldValue);

      await expectFHERC20BalancesChange(eBTC, bob.address, confidentialValue);
      await hre.cofhe.mocks.expectPlaintext(await eBTC.confidentialTotalSupply(), confidentialValue * 2n);
    });
  });

  describe("unshield & claimUnshielded (FHERC20 → ERC20)", function () {
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

      await prepExpectFHERC20BalancesChange(eBTC, bob.address);

      const tx = await eBTC
        .connect(bob)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldConfidentialValue);

      await expect(tx).to.emit(eBTC, "Unshielded");
      await expectFHERC20BalancesChange(eBTC, bob.address, -1n * unshieldConfidentialValue);

      const { ctHash, claimId } = await getUnshieldRequest(tx, eBTC, alice.address);

      // Verify claim was created via getClaim (keyed by the unique claim id)
      const pendingClaim = await eBTC.getClaim(claimId);
      expect(pendingClaim.to).to.equal(alice.address);
      expect(pendingClaim.claimed).to.equal(false);

      // Verify getUserClaims tracks the pending claim (the burned handle is kept as ctHash)
      const aliceClaims = await eBTC.getUserClaims(alice.address);
      expect(aliceClaims.length).to.equal(1);
      expect(BigInt(aliceClaims[0].ctHash)).to.equal(BigInt(ctHash));

      // Time travel past decryption delay
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      await prepExpectERC20BalancesChange(wBTC, alice.address);

      await expect(eBTC.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature)).to.emit(
        eBTC,
        "ClaimedUnshielded",
      );

      await expectERC20BalancesChange(wBTC, alice.address, unshieldERC20Value);

      // Claim is marked as claimed and removed from user's pending claims
      const claimedClaim = await eBTC.getClaim(claimId);
      expect(claimedClaim.claimed).to.equal(true);

      const aliceClaimsAfter = await eBTC.getUserClaims(alice.address);
      expect(aliceClaimsAfter.length).to.equal(0);
    });

    it("should allow unshield by operator", async function () {
      const { eBTC, bob, alice, wBTC, aliceClient } = await setupShieldedFixture();

      const unshieldConfidentialValue = 1_000_000n;
      const unshieldERC20Value = unshieldConfidentialValue * conversionRate;

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await eBTC.connect(bob).setOperator(alice.address, timestamp);

      await prepExpectFHERC20BalancesChange(eBTC, bob.address);

      const tx = await eBTC
        .connect(alice)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldConfidentialValue);

      await expect(tx).to.emit(eBTC, "Unshielded");
      await expectFHERC20BalancesChange(eBTC, bob.address, -1n * unshieldConfidentialValue);

      const { ctHash, claimId } = await getUnshieldRequest(tx, eBTC, alice.address);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await aliceClient.decryptForTx(ctHash).withoutACP().execute();

      await prepExpectERC20BalancesChange(wBTC, alice.address);

      await eBTC.connect(alice).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

      await expectERC20BalancesChange(wBTC, alice.address, unshieldERC20Value);
    });

    it("should support batch claim", async function () {
      const { eBTC, bob, alice, wBTC, bobClient } = await setupShieldedFixture();

      const unshieldAmount1 = 500_000n;
      const unshieldAmount2 = 300_000n;

      // Create first unshield
      const tx1 = await eBTC
        .connect(bob)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldAmount1);
      const request1 = await getUnshieldRequest(tx1, eBTC, alice.address);

      // Create second unshield
      const tx2 = await eBTC
        .connect(bob)
        ["unshield(address,address,uint64)"](bob.address, alice.address, unshieldAmount2);
      const request2 = await getUnshieldRequest(tx2, eBTC, alice.address);

      // Alice should have 2 pending claims
      const pendingClaims = await eBTC.getUserClaims(alice.address);
      expect(pendingClaims.length).to.equal(2);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const dec1 = await bobClient.decryptForTx(request1.ctHash).withoutACP().execute();
      const dec2 = await bobClient.decryptForTx(request2.ctHash).withoutACP().execute();

      await prepExpectERC20BalancesChange(wBTC, alice.address);

      await eBTC
        .connect(bob)
        .claimUnshieldedBatch(
          [request1.claimId, request2.claimId],
          [dec1.decryptedValue, dec2.decryptedValue],
          [dec1.signature, dec2.signature],
        );

      const totalERC20Value = (unshieldAmount1 + unshieldAmount2) * conversionRate;
      await expectERC20BalancesChange(wBTC, alice.address, totalERC20Value);

      // All claims cleared
      const claimsAfter = await eBTC.getUserClaims(alice.address);
      expect(claimsAfter.length).to.equal(0);
    });

    it("should complete unshield and claim flow with encrypted amount (sharedEuint64)", async function () {
      const { eBTC, bob, alice, wBTC, bobClient } = await setupFixture();

      // The bytes32 overload now takes a `sharedEuint64`, and only a contract can produce one:
      // sharing goes through FHE.shareEuint64, which an EOA cannot call. A composing contract
      // holds the confidential balance and shares it with the wrapper.
      const caller = await (await ethers.getContractFactory("MockSharedAmountCaller")).deploy();
      const callerAddr = await caller.getAddress();

      const unshieldConfidentialValue = 1_000_000n;
      const unshieldERC20Value = unshieldConfidentialValue * conversionRate; // 1e8

      // Shield exactly the unshield amount into the helper so its balance handle matches.
      await wBTC.mint(bob, unshieldERC20Value);
      await wBTC.connect(bob).approve(eBTC.target, unshieldERC20Value);
      await eBTC.connect(bob).shield(callerAddr, unshieldERC20Value);

      await prepExpectFHERC20BalancesChange(eBTC, callerAddr);

      const tx = await caller.unshieldOwnBalanceOnWrapper(await eBTC.getAddress(), alice.address);

      await expect(tx).to.emit(eBTC, "Unshielded");
      await expectFHERC20BalancesChange(eBTC, callerAddr, -1n * unshieldConfidentialValue);

      const { ctHash, claimId } = await getUnshieldRequest(tx, eBTC, alice.address);

      // Verify claim was created via getClaim (keyed by the unique claim id)
      const pendingClaim = await eBTC.getClaim(claimId);
      expect(pendingClaim.to).to.equal(alice.address);
      expect(pendingClaim.decryptedAmount).to.equal(0n);
      expect(pendingClaim.claimed).to.equal(false);

      // Verify getUserClaims tracks the pending claim (the burned handle is kept as ctHash)
      const aliceClaims = await eBTC.getUserClaims(alice.address);
      expect(aliceClaims.length).to.equal(1);
      expect(BigInt(aliceClaims[0].ctHash)).to.equal(BigInt(ctHash));

      // Time travel past decryption delay
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      await prepExpectERC20BalancesChange(wBTC, alice.address);

      await expect(eBTC.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature)).to.emit(
        eBTC,
        "ClaimedUnshielded",
      );

      await expectERC20BalancesChange(wBTC, alice.address, unshieldERC20Value);

      // Claim is marked as claimed and removed from user's pending claims
      const claimedClaim = await eBTC.getClaim(claimId);
      expect(claimedClaim.claimed).to.equal(true);

      const aliceClaimsAfter = await eBTC.getUserClaims(alice.address);
      expect(aliceClaimsAfter.length).to.equal(0);
    });
  });

  describe("unshield reverts", function () {
    it("should revert on zero address receiver", async function () {
      const { eBTC, bob, wBTC } = await setupFixture();

      const mintValue = BigInt(10e8);
      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);
      await eBTC.connect(bob).shield(bob, mintValue);

      await expect(
        eBTC.connect(bob)["unshield(address,address,uint64)"](bob.address, ZeroAddress, 1_000_000n),
      ).to.be.revertedWithCustomError(eBTC, "FHERC20InvalidReceiver");
    });

    it("should revert when caller is not operator", async function () {
      const { eBTC, bob, alice, wBTC } = await setupFixture();

      const mintValue = BigInt(10e8);
      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);
      await eBTC.connect(bob).shield(bob, mintValue);

      await expect(
        eBTC.connect(alice)["unshield(address,address,uint64)"](bob.address, alice.address, 1_000_000n),
      ).to.be.revertedWithCustomError(eBTC, "FHERC20UnauthorizedSpender");
    });
  });

  describe("claimUnshielded reverts", function () {
    it("should revert on invalid request id", async function () {
      const { eBTC } = await setupFixture();

      await expect(eBTC.claimUnshielded(ethers.ZeroHash, 0n, new Uint8Array(0))).to.be.revertedWithCustomError(
        eBTC,
        "ClaimNotFound",
      );
    });

    it("should revert when claiming already claimed request", async function () {
      const { eBTC, bob, alice, wBTC, bobClient } = await setupFixture();

      const mintValue = BigInt(10e8);
      await wBTC.mint(bob, mintValue);
      await wBTC.connect(bob).approve(eBTC.target, mintValue);
      await eBTC.connect(bob).shield(bob, mintValue);

      const tx = await eBTC.connect(bob)["unshield(address,address,uint64)"](bob.address, alice.address, 1_000_000n);
      const { ctHash, claimId } = await getUnshieldRequest(tx, eBTC, alice.address);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      // First claim succeeds
      await eBTC.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

      // Second claim reverts
      await expect(
        eBTC.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature),
      ).to.be.revertedWithCustomError(eBTC, "AlreadyClaimed");
    });
  });

  describe("onTransferReceived", function () {
    it("should revert when called by non-underlying token", async function () {
      const { eBTC, bob } = await setupFixture();

      await expect(
        eBTC.connect(bob).onTransferReceived(bob.address, bob.address, 1000n, "0x"),
      ).to.be.revertedWithCustomError(eBTC, "FHERC20UnauthorizedCaller");
    });
  });
});
