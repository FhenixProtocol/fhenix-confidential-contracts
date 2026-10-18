import { expect } from "chai";
import hre, { ethers } from "hardhat";
import {
  MockERC20Confidential,
  ERC20ConfidentialUpgradeable_Harness,
  ERC20ConfidentialIndicator,
  MockFHERC20Receiver,
} from "../typechain-types";
import { CofheClient, Encryptable } from "@cofhe/sdk";
import { ContractTransactionResponse, ZeroAddress } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  prepExpectERC20BalancesChange,
  expectERC20BalancesChange,
  prepExpectFHERC20BalancesChange,
  expectFHERC20BalancesChange,
} from "./utils";
import { getIFHERC20InterfaceId } from "./FHERC20.behavior";

type ERC20ConfidentialToken = MockERC20Confidential | ERC20ConfidentialUpgradeable_Harness;

export interface SetupFixtureResult {
  token: ERC20ConfidentialToken;
  indicator: ERC20ConfidentialIndicator;
  owner: HardhatEthersSigner;
  bob: HardhatEthersSigner;
  alice: HardhatEthersSigner;
  ownerClient: CofheClient;
  bobClient: CofheClient;
  aliceClient: CofheClient;
}

type SetupFixtureFn = () => Promise<SetupFixtureResult>;
type DeployWithDecimalsFn = (decimals: number) => Promise<ERC20ConfidentialToken>;

// The unshield flow now involves TWO distinct identifiers (they used to coincide when claims
// were keyed by the ciphertext handle):
//  - `ctHash`  — the burned ciphertext handle from the TokensUnshielded event; the DECRYPTION target.
//  - `claimId` — the unique per-claimant claim key (keccak256(to, nonce++, handle)); what
//                claimUnshielded/getClaim take. Read from getUserClaims.
async function getUnshieldRequest(
  tx: ContractTransactionResponse,
  contract: ERC20ConfidentialToken,
  user: string,
): Promise<{ ctHash: string; claimId: string }> {
  const receipt = await tx.wait();
  let ctHash: string | undefined;
  for (const log of receipt!.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "TokensUnshielded") {
        ctHash = parsed.args.amount;
      }
    } catch {}
  }
  if (ctHash === undefined) throw new Error("TokensUnshielded event not found");

  const claims = await contract.getUserClaims(user);
  const claim = claims.find(c => !c.claimed && BigInt(c.ctHash) === BigInt(ctHash!));
  if (!claim) throw new Error("pending claim for unshield not found");
  return { ctHash, claimId: claim.id };
}

/// The amount actually moved, read off the ConfidentialTransfer log. `update()` derives it from the
/// debit itself, so it is the authoritative record of what the transfer did — the requested amount
/// is only an upper bound on it.
async function confidentialTransferAmount(
  tx: ContractTransactionResponse,
  contract: ERC20ConfidentialToken,
): Promise<string> {
  const receipt = await tx.wait();
  for (const log of receipt!.logs) {
    try {
      const parsed = contract.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "ConfidentialTransfer") return parsed.args.amount;
    } catch {}
  }
  throw new Error("ConfidentialTransfer event not found");
}

export function shouldBehaveLikeERC20Confidential(
  setupFixture: SetupFixtureFn,
  deployWithDecimals: DeployWithDecimalsFn,
) {
  describe("Initialization", function () {
    it("Should be constructed correctly", async function () {
      const { token, indicator } = await setupFixture();

      expect(await token.name()).to.equal("Confidential Token");
      expect(await token.symbol()).to.equal("CTK");
      expect(await token.decimals()).to.equal(18);
      expect(await token.confidentialDecimals()).to.equal(6);

      expect(await indicator.name()).to.equal("1011000 Confidential Token");
      expect(await indicator.symbol()).to.equal("cCTK");
      expect(await indicator.decimals()).to.equal(4);
    });

    it("Should advertise IFHERC20 in real-ledger mode", async function () {
      const { token } = await setupFixture();

      expect(await token.supportsInterface(getIFHERC20InterfaceId())).to.equal(true);
      expect(await token.balanceOfIsIndicator()).to.equal(false);
      expect(await token.indicatorTick()).to.equal(0n);
    });
  });

  describe("Shielding (Public -> Confidential)", function () {
    it("Should shield tokens correctly", async function () {
      const { token, indicator, bob } = await setupFixture();

      const mintAmount = ethers.parseEther("100");
      await token.mint(bob.address, mintAmount);

      expect(await token.balanceOf(bob.address)).to.equal(mintAmount);

      const shieldAmount = ethers.parseEther("10");
      const expectedConfidentialAmount = BigInt(10 * 1e6);

      await prepExpectERC20BalancesChange(token, bob.address);

      await expect(token.connect(bob).shield(shieldAmount))
        .to.emit(token, "TokensShielded")
        .withArgs(bob.address, shieldAmount);

      await expectERC20BalancesChange(token, bob.address, -1n * shieldAmount);

      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, expectedConfidentialAmount);

      expect(await indicator.balanceOf(bob.address)).to.equal(10110005001n);
    });

    it("Should fail to shield amounts too small for confidential precision", async function () {
      const { token, bob } = await setupFixture();

      const dustAmount = BigInt(1e11);
      await token.mint(bob.address, ethers.parseEther("1"));

      await expect(token.connect(bob).shield(dustAmount)).to.be.revertedWithCustomError(
        token,
        "AmountTooSmallForConfidentialPrecision",
      );
    });
  });

  describe("Unshielding (Confidential -> Public)", function () {
    it("Should unshield tokens correctly", async function () {
      const { token, bob, bobClient } = await setupFixture();

      const initialAmount = ethers.parseEther("100");
      await token.mint(bob.address, initialAmount);
      await token.connect(bob).shield(initialAmount);

      const unshieldAmountConfidential = BigInt(50 * 1e6);
      const unshieldAmountPublic = ethers.parseEther("50");

      const tx = await token.connect(bob)["unshield(uint64)"](unshieldAmountConfidential);
      await expect(tx).to.emit(token, "TokensUnshielded");

      const { ctHash, claimId } = await getUnshieldRequest(tx, token, bob.address);

      const balanceHandle = await token.confidentialBalanceOf(bob.address);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, BigInt(50 * 1e6));

      expect(await token.balanceOf(bob.address)).to.equal(0);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      await expect(
        token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature),
      ).to.emit(token, "UnshieldedTokensClaimed");

      expect(await token.balanceOf(bob.address)).to.equal(unshieldAmountPublic);
    });

    it("Should unshield using an encrypted (sharedEuint64) amount", async function () {
      const { token, bob, bobClient } = await setupFixture();

      // The bytes32 overload now takes a `sharedEuint64`, and only a contract can produce one:
      // sharing goes through FHE.shareEuint64, which an EOA cannot call. So a composing
      // contract stands in for the holder — it shields its own balance and shares that.
      const caller = await (await ethers.getContractFactory("MockSharedAmountCaller")).deploy();
      const callerAddr = await caller.getAddress();
      const tokenAddr = await token.getAddress();

      const initialAmount = ethers.parseEther("100");
      await token.mint(callerAddr, initialAmount);
      await caller.shieldOwn(tokenAddr, initialAmount);

      const tx = await caller.unshieldOwnBalance(tokenAddr);
      await expect(tx).to.emit(token, "TokensUnshielded");

      const { ctHash, claimId } = await getUnshieldRequest(tx, token, callerAddr);

      // Claim is keyed by the unique claim id; the burned handle is kept as `ctHash`.
      // The settle amount stays unknown (decryptedAmount = 0) until the decryption proof.
      const pendingClaim = await token.getClaim(claimId);
      expect(pendingClaim.to).to.equal(callerAddr);
      expect(BigInt(pendingClaim.ctHash)).to.equal(BigInt(ctHash));
      expect(pendingClaim.decryptedAmount).to.equal(0n);
      expect(pendingClaim.claimed).to.equal(false);

      // Confidential balance is now zero.
      const balanceHandle = await token.confidentialBalanceOf(callerAddr);
      await hre.cofhe.mocks.expectPlaintext(balanceHandle, 0n);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      // The burned handle is made public by `unshield`, so any client can produce the proof.
      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

      await expect(
        token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature),
      ).to.emit(token, "UnshieldedTokensClaimed");

      // Full original public amount is returned.
      expect(await token.balanceOf(callerAddr)).to.equal(initialAmount);

      const claimsAfter = await token.getUserClaims(callerAddr);
      expect(claimsAfter.length).to.equal(0);
    });

    it("Should revert encrypted unshield when caller has no ACL access to the amount", async function () {
      const { token, bob } = await setupFixture();

      const caller = await (await ethers.getContractFactory("MockSharedAmountCaller")).deploy();
      const tokenAddr = await token.getAddress();
      const acl = await hre.cofhe.mocks.getMockACL();

      // Bob shields, so bob's balance handle is allowed for bob — not for the helper.
      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const bobBalanceHandle = await token.confidentialBalanceOf(bob.address);

      // Sharing is what carries provenance now: a contract cannot share a handle it was never
      // granted access to, so this fails before the token is even called.
      await expect(caller.unshieldForeignHandle(tokenAddr, bobBalanceHandle)).to.be.revertedWithCustomError(
        acl,
        "SenderNotAllowed",
      );

      // A bare handle pushed across the boundary with no share at all is rejected by the token
      // when it consumes the parameter.
      await expect(caller.unshieldWithoutSharing(tokenAddr, bobBalanceHandle)).to.be.revertedWithCustomError(
        acl,
        "NotShared",
      );
    });

    it("Should support multiple concurrent unshield claims", async function () {
      const { token, bob, bobClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const tx1 = await token.connect(bob)["unshield(uint64)"](BigInt(3 * 1e6));
      const request1 = await getUnshieldRequest(tx1, token, bob.address);

      const tx2 = await token.connect(bob)["unshield(uint64)"](BigInt(2 * 1e6));
      const request2 = await getUnshieldRequest(tx2, token, bob.address);

      const pendingClaims = await token.getUserClaims(bob.address);
      expect(pendingClaims.length).to.equal(2);

      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const dec1 = await bobClient.decryptForTx(request1.ctHash).withoutACP().execute();
      const dec2 = await bobClient.decryptForTx(request2.ctHash).withoutACP().execute();

      await token.connect(bob).claimUnshielded(request1.claimId, dec1.decryptedValue, dec1.signature);
      await token.connect(bob).claimUnshielded(request2.claimId, dec2.decryptedValue, dec2.signature);

      expect(await token.balanceOf(bob.address)).to.equal(ethers.parseEther("5"));

      const claimsAfter = await token.getUserClaims(bob.address);
      expect(claimsAfter.length).to.equal(0);
    });
  });

  // confidentialTotalSupply() is a REGISTERED, publicly-decryptable handle mirroring the pool's
  // public balance (scaled to confidential decimals), refreshed by the library on every
  // shield / claim / confidential mint. Assert both the handle's plaintext and the pool balance
  // that backs it.
  describe("Confidential Total Supply", function () {
    it("Should start with a zero supply handle and an empty pool", async function () {
      const { token } = await setupFixture();
      expect(await token.balanceOf(await token.CONFIDENTIAL_POOL())).to.equal(0n);
      // No supply-changing operation yet — the stored handle is still the zero handle.
      expect(await token.confidentialTotalSupply()).to.equal(0n);
    });

    it("Should equal the shielded amount after a single shield", async function () {
      const { token, bob } = await setupFixture();

      const shieldAmount = ethers.parseEther("10");
      await token.mint(bob.address, shieldAmount);
      await token.connect(bob).shield(shieldAmount);

      expect(await token.balanceOf(await token.CONFIDENTIAL_POOL())).to.equal(shieldAmount);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(10 * 1e6));
      expect(await token.confidentialTotalSupplyPlaintext()).to.equal(BigInt(10 * 1e6));
    });

    it("Should accumulate across shields by different users", async function () {
      const { token, bob, alice } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.mint(alice.address, ethers.parseEther("5"));

      await token.connect(bob).shield(ethers.parseEther("10"));
      expect(await token.balanceOf(await token.CONFIDENTIAL_POOL())).to.equal(ethers.parseEther("10"));
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(10 * 1e6));

      await token.connect(alice).shield(ethers.parseEther("5"));
      expect(await token.balanceOf(await token.CONFIDENTIAL_POOL())).to.equal(ethers.parseEther("15"));
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(15 * 1e6));
    });

    it("Should be unchanged by unshield until the claim settles", async function () {
      const { token, bob, bobClient } = await setupFixture();

      const initialAmount = ethers.parseEther("100");
      await token.mint(bob.address, initialAmount);
      await token.connect(bob).shield(initialAmount);

      expect(await token.balanceOf(await token.CONFIDENTIAL_POOL())).to.equal(initialAmount);

      const unshieldAmount = BigInt(50 * 1e6);
      const tx = await token.connect(bob)["unshield(uint64)"](unshieldAmount);

      // Pool still holds the public tokens — balance (and the supply handle) should be
      // unchanged until the claim settles: the supply still counts pending claims.
      expect(await token.balanceOf(await token.CONFIDENTIAL_POOL())).to.equal(initialAmount);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(100 * 1e6));

      const { ctHash, claimId } = await getUnshieldRequest(tx, token, bob.address);
      await hre.network.provider.send("evm_increaseTime", [11]);
      await hre.network.provider.send("evm_mine");

      const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();
      await token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

      // Claim drains the pool — unshieldAmount is in confidential units, scale it to public units.
      const rate = 10n ** (BigInt(await token.decimals()) - BigInt(await token.confidentialDecimals()));
      expect(await token.balanceOf(await token.CONFIDENTIAL_POOL())).to.equal(initialAmount - unshieldAmount * rate);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(50 * 1e6));
    });

    it("Should let anyone heal drift from direct public transfers to the pool", async function () {
      const { token, bob, alice } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("15"));
      await token.connect(bob).shield(ethers.parseEther("10"));
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(10 * 1e6));

      // A donation straight to the pool address bypasses the shield/claim/mint refresh
      // points — the stored handle goes stale, but the derived-on-read plaintext twin
      // is already current.
      await token.connect(bob).transfer(await token.CONFIDENTIAL_POOL(), ethers.parseEther("5"));
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(10 * 1e6));
      expect(await token.confidentialTotalSupplyPlaintext()).to.equal(BigInt(15 * 1e6));

      // Permissionless: any account can re-derive the handle from the pool's public balance.
      await token.connect(alice).syncConfidentialTotalSupply();
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), BigInt(15 * 1e6));
    });
  });

  describe("Confidential Transfers", function () {
    it("Should transfer encrypted tokens correctly", async function () {
      const { token, indicator, bob, alice, bobClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const transferAmount = BigInt(5 * 1e6);

      const [encTransferInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(transferAmount)])
        .setConsumingContract(await token.getAddress())
        .execute();

      await expect(
        token.connect(bob)["confidentialTransfer(address,bytes32,bytes)"](alice.address, encTransferInput, inputProof),
      ).to.emit(token, "ConfidentialTransfer");

      const bobBalance = await token.confidentialBalanceOf(bob.address);
      const aliceBalance = await token.confidentialBalanceOf(alice.address);

      await hre.cofhe.mocks.expectPlaintext(bobBalance, BigInt(5 * 1e6));
      await hre.cofhe.mocks.expectPlaintext(aliceBalance, BigInt(5 * 1e6));

      expect(await indicator.balanceOf(bob.address)).to.equal(10110005000n);
      expect(await indicator.balanceOf(alice.address)).to.equal(10110005001n);
    });

    // The debit is saturating and all-or-nothing (FHESafeMath.tryDecrease): an over-balance transfer
    // moves NOTHING rather than reverting or draining what is there. Asserted on the event's
    // transferred handle as well as the balances, since the credit leg is driven by exactly that
    // value — if it ever reported the requested amount instead of the debited one, the recipient
    // would be credited tokens the sender never lost.
    it("Should no-op a transfer that exceeds the balance", async function () {
      const { token, bob, alice, bobClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10")); // 10e6 confidential units

      const [encTransferInput, inputProof] = await bobClient
        .encryptInputs([Encryptable.uint64(BigInt(20 * 1e6))]) // twice the balance
        .setConsumingContract(await token.getAddress())
        .execute();

      const tx = await token
        .connect(bob)
        ["confidentialTransfer(address,bytes32,bytes)"](alice.address, encTransferInput, inputProof);

      await hre.cofhe.mocks.expectPlaintext(await confidentialTransferAmount(tx, token), 0n);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialBalanceOf(bob.address), BigInt(10 * 1e6));
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialBalanceOf(alice.address), 0n);
    });

    // The sender's balance slot is still the zero handle here, which is a distinct tryDecrease branch
    // from "initialized but too small" — and one this path can actually reach, since the
    // confidential core has no zero-balance guard (unlike FHERC20Core, which reverts). It must
    // no-op rather than revert, and must leave both parties holding real, decryptable handles.
    it("Should no-op a transfer from an account that never held a confidential balance", async function () {
      const { token, bob, alice, aliceClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      // Alice never shielded: no ciphertext was ever written for her balance.
      expect(await token.confidentialBalanceOf(alice.address)).to.equal(ethers.ZeroHash);

      const [encTransferInput, inputProof] = await aliceClient
        .encryptInputs([Encryptable.uint64(BigInt(1 * 1e6))])
        .setConsumingContract(await token.getAddress())
        .execute();

      const tx = await token
        .connect(alice)
        ["confidentialTransfer(address,bytes32,bytes)"](bob.address, encTransferInput, inputProof);

      await hre.cofhe.mocks.expectPlaintext(await confidentialTransferAmount(tx, token), 0n);
      await hre.cofhe.mocks.expectPlaintext(await token.confidentialBalanceOf(bob.address), BigInt(10 * 1e6));

      const aliceBalance = await token.confidentialBalanceOf(alice.address);
      expect(aliceBalance).to.not.equal(ethers.ZeroHash);
      await hre.cofhe.mocks.expectPlaintext(aliceBalance, 0n);
    });
  });

  describe("Operators", function () {
    it("Should allow operator to transfer confidential tokens", async function () {
      const { token, bob, alice, aliceClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
      await token.connect(bob).setOperator(alice.address, timestamp);

      expect(await token.isOperator(bob.address, alice.address)).to.equal(true);

      const transferAmount = BigInt(3 * 1e6);
      const [encTransferInput, inputProof] = await aliceClient
        .encryptInputs([Encryptable.uint64(transferAmount)])
        .setConsumingContract(await token.getAddress())
        .execute();

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,bytes32,bytes)"
          ](bob.address, alice.address, encTransferInput, inputProof),
      ).to.emit(token, "ConfidentialTransfer");

      const bobBalance = await token.confidentialBalanceOf(bob.address);
      const aliceBalance = await token.confidentialBalanceOf(alice.address);

      await hre.cofhe.mocks.expectPlaintext(bobBalance, BigInt(7 * 1e6));
      await hre.cofhe.mocks.expectPlaintext(aliceBalance, BigInt(3 * 1e6));
    });

    it("Should revert transferFrom without operator approval", async function () {
      const { token, bob, alice, aliceClient } = await setupFixture();

      await token.mint(bob.address, ethers.parseEther("10"));
      await token.connect(bob).shield(ethers.parseEther("10"));

      const transferAmount = BigInt(3 * 1e6);
      const [encTransferInput, inputProof] = await aliceClient
        .encryptInputs([Encryptable.uint64(transferAmount)])
        .setConsumingContract(await token.getAddress())
        .execute();

      await expect(
        token
          .connect(alice)
          [
            "confidentialTransferFrom(address,address,bytes32,bytes)"
          ](bob.address, alice.address, encTransferInput, inputProof),
      ).to.be.revertedWithCustomError(token, "ERC20ConfidentialUnauthorizedSpender");
    });
  });

  describe("Confidential Transfer And Call", function () {
    async function deployReceiver(): Promise<MockFHERC20Receiver> {
      const factory = await ethers.getContractFactory("MockFHERC20Receiver");
      const receiver = (await factory.deploy()) as MockFHERC20Receiver;
      await receiver.waitForDeployment();
      return receiver;
    }

    describe("confidentialTransferAndCall", function () {
      async function setupTransferAndCallFixture() {
        const { token, bob, alice, bobClient } = await setupFixture();

        await token.mint(bob.address, ethers.parseEther("10"));
        await token.connect(bob).shield(ethers.parseEther("10"));

        const receiver = await deployReceiver();

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput, inputProof] = await bobClient
          .encryptInputs([Encryptable.uint64(transferValue)])
          .setConsumingContract(await token.getAddress())
          .execute();

        return { token, bob, alice, receiver, encTransferInput, inputProof, transferValue };
      }

      it("should transfer with callback to receiver (success)", async function () {
        const { token, bob, receiver, encTransferInput, inputProof, transferValue } =
          await setupTransferAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

        const tx = await token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
          ](receiverAddress, encTransferInput, inputProof, callData);

        await expect(tx).to.emit(receiver, "ConfidentialTransferCallback").withArgs(true);

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, receiverAddress, transferValue);
      });

      it("should transfer with callback to receiver (failure - refund)", async function () {
        const { token, bob, receiver, encTransferInput, inputProof } = await setupTransferAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);

        await expect(
          token
            .connect(bob)
            [
              "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
            ](receiverAddress, encTransferInput, inputProof, callData),
        ).to.emit(receiver, "ConfidentialTransferCallback");

        await expectFHERC20BalancesChange(token, bob.address, 0n);
        await expectFHERC20BalancesChange(token, receiverAddress, 0n);
      });

      it("should transfer with callback to EOA (always succeeds)", async function () {
        const { token, bob, alice, encTransferInput, inputProof, transferValue } = await setupTransferAndCallFixture();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, alice.address);

        const tx = await token
          .connect(bob)
          [
            "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
          ](alice.address, encTransferInput, inputProof, "0x");

        await expect(tx).to.emit(token, "ConfidentialTransfer");

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, alice.address, transferValue);
      });

      it("should revert with custom error from callback", async function () {
        const { token, bob, receiver, encTransferInput, inputProof } = await setupTransferAndCallFixture();

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [2]);

        await expect(
          token
            .connect(bob)
            [
              "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
            ](await receiver.getAddress(), encTransferInput, inputProof, callData),
        )
          .to.be.revertedWithCustomError(receiver, "InvalidInput")
          .withArgs(2);
      });

      it("should revert on transfer to zero address", async function () {
        const { token, bob, encTransferInput, inputProof } = await setupTransferAndCallFixture();

        await expect(
          token
            .connect(bob)
            [
              "confidentialTransferAndCall(address,bytes32,bytes,bytes)"
            ](ZeroAddress, encTransferInput, inputProof, "0x"),
        ).to.be.revertedWithCustomError(token, "ConfidentialInvalidReceiver"); // was ERC20InvalidReceiver pre-Core
      });
    });

    describe("confidentialTransferFromAndCall", function () {
      async function setupTransferFromAndCallFixture() {
        const { token, bob, alice, aliceClient } = await setupFixture();
        const [, , , eve] = await ethers.getSigners();
        const eveClient = await hre.cofhe.createClientWithBatteries(eve);

        await token.mint(bob.address, ethers.parseEther("10"));
        await token.connect(bob).shield(ethers.parseEther("10"));

        const receiver = await deployReceiver();

        return { token, bob, alice, eve, receiver, aliceClient, eveClient };
      }

      it("should transfer from bob to receiver with callback (as operator, success)", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput, inputProof] = await aliceClient
          .encryptInputs([Encryptable.uint64(transferValue)])
          .setConsumingContract(await token.getAddress())
          .execute();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

        const tx = await token
          .connect(alice)
          [
            "confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)"
          ](bob.address, receiverAddress, encTransferInput, inputProof, callData);

        await expect(tx).to.emit(receiver, "ConfidentialTransferCallback").withArgs(true);

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, receiverAddress, transferValue);
      });

      it("should transfer from bob to receiver with callback (failure - refund)", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();
        const receiverAddress = await receiver.getAddress();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput, inputProof] = await aliceClient
          .encryptInputs([Encryptable.uint64(transferValue)])
          .setConsumingContract(await token.getAddress())
          .execute();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, receiverAddress);

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [0]);

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)"
            ](bob.address, receiverAddress, encTransferInput, inputProof, callData),
        ).to.emit(receiver, "ConfidentialTransferCallback");

        await expectFHERC20BalancesChange(token, bob.address, 0n);
        await expectFHERC20BalancesChange(token, receiverAddress, 0n);
      });

      it("should transfer from bob to alice (EOA) with callback via eve as operator", async function () {
        const { token, bob, alice, eve, eveClient } = await setupTransferFromAndCallFixture();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(eve.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput, inputProof] = await eveClient
          .encryptInputs([Encryptable.uint64(transferValue)])
          .setConsumingContract(await token.getAddress())
          .execute();

        await prepExpectFHERC20BalancesChange(token, bob.address);
        await prepExpectFHERC20BalancesChange(token, alice.address);

        const tx = await token
          .connect(eve)
          [
            "confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)"
          ](bob.address, alice.address, encTransferInput, inputProof, "0x");

        await expect(tx).to.emit(token, "ConfidentialTransfer");

        await expectFHERC20BalancesChange(token, bob.address, -1n * transferValue);
        await expectFHERC20BalancesChange(token, alice.address, transferValue);
      });

      it("should revert without operator approval", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput, inputProof] = await aliceClient
          .encryptInputs([Encryptable.uint64(transferValue)])
          .setConsumingContract(await token.getAddress())
          .execute();

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [1]);

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)"
            ](bob.address, await receiver.getAddress(), encTransferInput, inputProof, callData),
        ).to.be.revertedWithCustomError(token, "ERC20ConfidentialUnauthorizedSpender");
      });

      it("should revert with custom error from callback", async function () {
        const { token, bob, alice, receiver, aliceClient } = await setupTransferFromAndCallFixture();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput, inputProof] = await aliceClient
          .encryptInputs([Encryptable.uint64(transferValue)])
          .setConsumingContract(await token.getAddress())
          .execute();

        const callData = ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [2]);

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)"
            ](bob.address, await receiver.getAddress(), encTransferInput, inputProof, callData),
        )
          .to.be.revertedWithCustomError(receiver, "InvalidInput")
          .withArgs(2);
      });

      it("should revert on transfer to zero address", async function () {
        const { token, bob, alice, aliceClient } = await setupTransferFromAndCallFixture();

        const timestamp = (await ethers.provider.getBlock("latest"))!.timestamp + 100;
        await token.connect(bob).setOperator(alice.address, timestamp);

        const transferValue = BigInt(1 * 1e6);
        const [encTransferInput, inputProof] = await aliceClient
          .encryptInputs([Encryptable.uint64(transferValue)])
          .setConsumingContract(await token.getAddress())
          .execute();

        await expect(
          token
            .connect(alice)
            [
              "confidentialTransferFromAndCall(address,address,bytes32,bytes,bytes)"
            ](bob.address, ZeroAddress, encTransferInput, inputProof, "0x"),
        ).to.be.revertedWithCustomError(token, "ConfidentialInvalidReceiver"); // was ERC20InvalidReceiver pre-Core
      });
    });
  });

  describe("Decimal Scenarios", function () {
    describe("4 Decimals (confidentialDecimals=4, rate=1)", function () {
      async function deploy4DecimalToken() {
        const [bob] = await ethers.getSigners();
        const token = await deployWithDecimals(4);
        const bobClient = await hre.cofhe.createClientWithBatteries(bob);
        return { token, bob, bobClient };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy4DecimalToken();
        expect(await token.decimals()).to.equal(4);
        expect(await token.confidentialDecimals()).to.equal(4);
      });

      it("Should shield/unshield with no precision loss", async function () {
        const { token, bob, bobClient } = await deploy4DecimalToken();

        const amount = BigInt(100000); // 10 * 10^4
        await token.mint(bob.address, amount);

        await token.connect(bob).shield(amount);

        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, amount);

        const tx = await token.connect(bob)["unshield(uint64)"](amount);
        const { ctHash, claimId } = await getUnshieldRequest(tx, token, bob.address);

        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();
        await token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

        expect(await token.balanceOf(bob.address)).to.equal(amount);
      });
    });

    describe("6 Decimals (confidentialDecimals=6, rate=1)", function () {
      async function deploy6DecimalToken() {
        const [bob] = await ethers.getSigners();
        const token = await deployWithDecimals(6);
        const bobClient = await hre.cofhe.createClientWithBatteries(bob);
        return { token, bob, bobClient };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy6DecimalToken();
        expect(await token.decimals()).to.equal(6);
        expect(await token.confidentialDecimals()).to.equal(6);
      });

      it("Should shield/unshield with no precision loss", async function () {
        const { token, bob, bobClient } = await deploy6DecimalToken();

        const amount = BigInt(10000000); // 10 * 10^6
        await token.mint(bob.address, amount);

        await token.connect(bob).shield(amount);

        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, amount);

        const tx = await token.connect(bob)["unshield(uint64)"](amount);
        const { ctHash, claimId } = await getUnshieldRequest(tx, token, bob.address);

        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();
        await token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

        expect(await token.balanceOf(bob.address)).to.equal(amount);
      });
    });

    describe("8 Decimals (confidentialDecimals=6, rate=100)", function () {
      async function deploy8DecimalToken() {
        const [bob] = await ethers.getSigners();
        const token = await deployWithDecimals(8);
        const bobClient = await hre.cofhe.createClientWithBatteries(bob);
        return { token, bob, bobClient };
      }

      it("Should have correct decimals and rate", async function () {
        const { token } = await deploy8DecimalToken();
        expect(await token.decimals()).to.equal(8);
        expect(await token.confidentialDecimals()).to.equal(6);
      });

      it("Should shield/unshield with correct rate conversion", async function () {
        const { token, bob, bobClient } = await deploy8DecimalToken();

        const publicAmount = BigInt(1000000000); // 10 * 10^8
        const expectedConfidentialAmount = BigInt(10000000); // 10 * 10^6

        await token.mint(bob.address, publicAmount);
        await token.connect(bob).shield(publicAmount);

        const balanceHandle = await token.confidentialBalanceOf(bob.address);
        await hre.cofhe.mocks.expectPlaintext(balanceHandle, expectedConfidentialAmount);

        const tx = await token.connect(bob)["unshield(uint64)"](expectedConfidentialAmount);
        const { ctHash, claimId } = await getUnshieldRequest(tx, token, bob.address);

        await hre.network.provider.send("evm_increaseTime", [11]);
        await hre.network.provider.send("evm_mine");

        const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();
        await token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);

        expect(await token.balanceOf(bob.address)).to.equal(publicAmount);
      });

      it("Should fail to shield amounts smaller than rate", async function () {
        const { token, bob } = await deploy8DecimalToken();

        const dustAmount = BigInt(50);
        await token.mint(bob.address, BigInt(1000000));

        await expect(token.connect(bob).shield(dustAmount)).to.be.revertedWithCustomError(
          token,
          "AmountTooSmallForConfidentialPrecision",
        );
      });
    });
  });
}
