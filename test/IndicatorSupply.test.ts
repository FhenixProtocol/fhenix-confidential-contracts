import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Encryptable } from "@cofhe/sdk";
import { MockERC20Confidential, ERC20ConfidentialIndicator } from "../typechain-types";

// Consensys Diligence 5.18 — the indicator returned a nonzero marker for EVERY address while the
// inherited totalSupply() stayed permanently 0, because _mint/_burn are never reached. Two
// consequences: a generic `balanceOf(x) > 0` eligibility check passed for all 2^160 addresses,
// and `totalSupply() == sum(balanceOf(x))` was unsatisfiable at any value, since the sum over all
// addresses was unbounded.
//
// The marker now applies only to accounts that have actually taken part in a confidential
// operation — matching FHERC20Core's indicator, which always behaved this way — and totalSupply
// is a tracked counter that equals the sum exactly.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";
const MARKER = 10_110_000_000n;

describe("indicator supply accounting (Diligence 5.18)", function () {
  async function fixture() {
    const [owner, bob, alice] = await ethers.getSigners();
    const lib = await ethers.deployContract(LIB_FQN);
    await lib.waitForDeployment();
    const token = (await (
      await ethers.getContractFactory("MockERC20Confidential", { libraries: { [LIB_FQN]: await lib.getAddress() } })
    ).deploy("Confidential Token", "CTK", 18)) as MockERC20Confidential;
    await token.waitForDeployment();

    const indicator = (await ethers.getContractAt(
      "ERC20ConfidentialIndicator",
      await token.indicatorToken(),
    )) as ERC20ConfidentialIndicator;

    const bobClient = await hre.cofhe.createClientWithBatteries(bob);
    return { owner, bob, alice, token, indicator, bobClient };
  }

  /// Asserts totalSupply() is exactly the sum of balanceOf over the accounts that could hold any.
  async function expectSupplyMatchesSum(indicator: ERC20ConfidentialIndicator, accounts: string[]) {
    let sum = 0n;
    for (const a of [...accounts, ethers.ZeroAddress]) sum += await indicator.balanceOf(a);
    expect(await indicator.totalSupply()).to.equal(sum);
  }

  it("reports zero for an address that has never taken part", async function () {
    const { indicator } = await fixture();

    const stranger = ethers.Wallet.createRandom().address;
    expect(await indicator.balanceOf(stranger)).to.equal(0n);
    expect(await indicator.totalSupply()).to.equal(0n);
  });

  it("still shows the marker once an account is active", async function () {
    const { token, indicator, bob } = await fixture();

    await token.mint(bob.address, ethers.parseEther("100"));
    await token.connect(bob).shield(ethers.parseEther("10"));

    // Unchanged from the pre-fix behaviour for a real participant.
    expect(await indicator.balanceOf(bob.address)).to.equal(MARKER + 5001n);
  });

  it("keeps totalSupply equal to the sum of balances through shield and transfer", async function () {
    const { token, indicator, bob, alice, bobClient } = await fixture();

    await expectSupplyMatchesSum(indicator, [bob.address, alice.address]);

    await token.mint(bob.address, ethers.parseEther("100"));
    await token.connect(bob).shield(ethers.parseEther("10"));
    await expectSupplyMatchesSum(indicator, [bob.address, alice.address]);
    expect(await indicator.totalSupply()).to.equal(MARKER + 5001n);

    const [enc, proof] = await bobClient
      .encryptInputs([Encryptable.uint64(1_000_000n)])
      .setConsumingContract(await token.getAddress())
      .execute();
    await token.connect(bob)["confidentialTransfer(address,bytes32,bytes)"](alice.address, enc, proof);

    // Two active accounts now: two markers plus their indicated balances.
    await expectSupplyMatchesSum(indicator, [bob.address, alice.address]);
    expect(await indicator.totalSupply()).to.equal(2n * MARKER + 5000n + 5001n);
  });

  it("does not count the zero address as a holder on a confidential mint", async function () {
    const { token, indicator, bob } = await fixture();

    // shield mints confidential balance, so the indicator leg runs with from == address(0).
    await token.mint(bob.address, ethers.parseEther("100"));
    await token.connect(bob).shield(ethers.parseEther("10"));

    expect(await indicator.balanceOf(ethers.ZeroAddress)).to.equal(0n);
    expect(await indicator.totalSupply()).to.equal(MARKER + 5001n);
  });

  it("keeps the sum exact across many operations", async function () {
    const { token, indicator, bob, alice, bobClient } = await fixture();

    await token.mint(bob.address, ethers.parseEther("1000"));
    await token.connect(bob).shield(ethers.parseEther("100"));

    for (let i = 0; i < 8; i++) {
      const [enc, proof] = await bobClient
        .encryptInputs([Encryptable.uint64(1_000n)])
        .setConsumingContract(await token.getAddress())
        .execute();
      await token.connect(bob)["confidentialTransfer(address,bytes32,bytes)"](alice.address, enc, proof);
    }

    await expectSupplyMatchesSum(indicator, [bob.address, alice.address]);
  });

  // The clamps are the only place the running sum can drift from the per-account balances: a
  // clamped update must not be counted. Reaching them needs ~5k operations, so this drives the
  // indicator directly as its parent rather than through the FHE transfer path.
  it("keeps the sum exact once both clamps are hit", async function () {
    const { token, indicator, bob, alice } = await fixture();

    const parent = await token.getAddress();
    await hre.network.provider.send("hardhat_impersonateAccount", [parent]);
    await hre.network.provider.send("hardhat_setBalance", [parent, "0xde0b6b3a7640000"]);
    const asParent = await ethers.getSigner(parent);

    // First call seeds bob at 5001 and alice at 4999; each later call moves them ±1, so both
    // reach their clamp after 4999 in total. Overshoot to prove the clamped calls change nothing.
    for (let i = 0; i < 5_100; i++) {
      await indicator.connect(asParent).emitConfidentialTransfer(alice.address, bob.address);
    }
    await hre.network.provider.send("hardhat_stopImpersonatingAccount", [parent]);

    expect(await indicator.balanceOf(bob.address)).to.equal(MARKER + 9_999n);
    expect(await indicator.balanceOf(alice.address)).to.equal(MARKER + 1n);
    await expectSupplyMatchesSum(indicator, [bob.address, alice.address]);
  });

  it("exposes the indicator marker interface", async function () {
    const { indicator } = await fixture();

    expect(await indicator.balanceOfIsIndicator()).to.equal(true);
    expect(await indicator.indicatorTick()).to.equal(1n);
  });
});
