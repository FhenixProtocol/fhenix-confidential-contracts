import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { ContractTransactionResponse } from "ethers";
import { ERC20_Harness, FHERC20ERC20WrapperUUPS, FHERC20NativeWrapperUUPS, WETH_Harness } from "../typechain-types";

// The wrappers delegate claim bookkeeping to the external ERC20ConfidentialLib, so link it.
const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

// bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type WrapperUUPS = FHERC20ERC20WrapperUUPS | FHERC20NativeWrapperUUPS;

async function implementationOf(proxy: WrapperUUPS): Promise<string> {
  const word = await ethers.provider.getStorage(await proxy.getAddress(), IMPLEMENTATION_SLOT);
  return ethers.getAddress(ethers.dataSlice(word, 12));
}

// Returns the burned handle (the decryption target) and the unique claim id (what claimUnshielded takes).
async function getUnshieldRequest(
  tx: ContractTransactionResponse,
  contract: WrapperUUPS,
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

async function deployProxy(implAddress: string, initData: string): Promise<string> {
  const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(implAddress, initData);
  await proxy.waitForDeployment();
  return proxy.getAddress();
}

// The owner is a different account from the deployer, so the tests prove `owner_` is what counts.
async function deployERC20Wrapper() {
  const [deployer, owner, bob, alice] = await ethers.getSigners();

  const wBTC = (await (
    await ethers.getContractFactory("ERC20_Harness")
  ).deploy("Wrapped BTC", "wBTC", 8)) as ERC20_Harness;
  await wBTC.waitForDeployment();

  const lib = await ethers.deployContract(LIB_FQN);
  await lib.waitForDeployment();
  const factory = await ethers.getContractFactory("FHERC20ERC20WrapperUUPS", {
    libraries: { [LIB_FQN]: await lib.getAddress() },
  });
  const impl = await factory.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData("initialize", [
    await wBTC.getAddress(),
    "FHERC20 Wrapped BTC",
    "eBTC",
    "https://example.com/ebtc.json",
    owner.address,
  ]);
  const token = factory.attach(await deployProxy(await impl.getAddress(), initData)) as FHERC20ERC20WrapperUUPS;

  return { deployer, owner, bob, alice, wBTC, token, factory, impl };
}

async function deployNativeWrapper() {
  const [deployer, owner, bob, alice] = await ethers.getSigners();

  const wETH = (await (await ethers.getContractFactory("WETH_Harness")).deploy()) as WETH_Harness;
  await wETH.waitForDeployment();

  const lib = await ethers.deployContract(LIB_FQN);
  await lib.waitForDeployment();
  const factory = await ethers.getContractFactory("FHERC20NativeWrapperUUPS", {
    libraries: { [LIB_FQN]: await lib.getAddress() },
  });
  const impl = await factory.deploy();
  await impl.waitForDeployment();

  const initData = impl.interface.encodeFunctionData("initialize", [
    await wETH.getAddress(),
    "FHERC20 Wrapped ETH",
    "eETH",
    "https://example.com/eeth.json",
    owner.address,
  ]);
  const token = factory.attach(await deployProxy(await impl.getAddress(), initData)) as FHERC20NativeWrapperUUPS;

  return { deployer, owner, bob, alice, wETH, token, factory, impl };
}

type UpgradeFixture = Pick<Awaited<ReturnType<typeof deployERC20Wrapper>>, "deployer" | "owner" | "bob" | "alice"> & {
  token: WrapperUUPS;
  impl: WrapperUUPS;
  factory: { deploy(): Promise<WrapperUUPS> };
};

function shouldGateUpgrades(deploy: () => Promise<UpgradeFixture>) {
  describe("upgrades", function () {
    it("rejects an upgrade from anyone but the owner", async function () {
      const { token, factory, deployer, bob } = await deploy();
      const next = await factory.deploy();
      await next.waitForDeployment();

      for (const caller of [deployer, bob]) {
        await expect(token.connect(caller).upgradeToAndCall(await next.getAddress(), "0x"))
          .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
          .withArgs(caller.address);
      }
    });

    it("lets the owner upgrade and keeps the token's config", async function () {
      const { token, factory, impl, owner } = await deploy();
      const before = [await token.name(), await token.symbol(), await token.decimals(), await token.rate()];
      const next = await factory.deploy();
      await next.waitForDeployment();

      expect(await implementationOf(token)).to.equal(await impl.getAddress());
      await token.connect(owner).upgradeToAndCall(await next.getAddress(), "0x");
      expect(await implementationOf(token)).to.equal(await next.getAddress());

      expect([await token.name(), await token.symbol(), await token.decimals(), await token.rate()]).to.deep.equal(
        before,
      );
      expect(await token.owner()).to.equal(owner.address);
    });

    it("moves upgrade authority only once the new owner accepts", async function () {
      const { token, factory, owner, bob, alice } = await deploy();
      const next = await factory.deploy();
      await next.waitForDeployment();

      await token.connect(owner).transferOwnership(alice.address);

      // Pending only: the old owner is still in charge and alice cannot upgrade yet.
      expect(await token.owner()).to.equal(owner.address);
      expect(await token.pendingOwner()).to.equal(alice.address);
      await expect(token.connect(alice).upgradeToAndCall(await next.getAddress(), "0x")).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount",
      );
      await expect(token.connect(bob).acceptOwnership()).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount",
      );

      await token.connect(alice).acceptOwnership();

      expect(await token.owner()).to.equal(alice.address);
      await expect(token.connect(owner).upgradeToAndCall(await next.getAddress(), "0x")).to.be.revertedWithCustomError(
        token,
        "OwnableUnauthorizedAccount",
      );
      await token.connect(alice).upgradeToAndCall(await next.getAddress(), "0x");
      expect(await implementationOf(token)).to.equal(await next.getAddress());
    });
  });
}

describe("FHERC20ERC20WrapperUUPS", function () {
  // wBTC has 8 decimals: rate = 100, confidential decimals = 6
  const rate = 100n;

  it("initializes through the proxy", async function () {
    const { token, wBTC, owner } = await deployERC20Wrapper();

    expect(await token.name()).to.equal("FHERC20 Wrapped BTC");
    expect(await token.symbol()).to.equal("eBTC");
    expect(await token.decimals()).to.equal(6);
    expect(await token.contractURI()).to.equal("https://example.com/ebtc.json");
    expect(await token.underlying()).to.equal(await wBTC.getAddress());
    expect(await token.rate()).to.equal(rate);
    expect(await token.owner()).to.equal(owner.address);
    // Sized from the capped 6 decimals. The underlying's 8 would give 10_000.
    expect(await token.indicatorTick()).to.equal(100n);
  });

  it("cannot be initialized twice, nor on the implementation", async function () {
    const { token, impl, wBTC, bob } = await deployERC20Wrapper();
    const underlying = await wBTC.getAddress();

    await expect(token.initialize(underlying, "X", "X", "", bob.address)).to.be.revertedWithCustomError(
      token,
      "InvalidInitialization",
    );
    await expect(impl.initialize(underlying, "X", "X", "", bob.address)).to.be.revertedWithCustomError(
      impl,
      "InvalidInitialization",
    );
  });

  it("rejects zero-aligned shields through the proxy and accepts the smallest aligned amount", async function () {
    const { token, wBTC, bob } = await deployERC20Wrapper();

    for (const amount of [0n, rate - 1n]) {
      await expect(token.connect(bob).shield(bob, amount)).to.be.revertedWithCustomError(
        token,
        "AmountTooSmallForConfidentialPrecision",
      );
    }

    await wBTC.mint(bob, rate);
    await wBTC.connect(bob).approve(token.target, rate);
    await token.connect(bob).shield(bob, rate);

    await hre.cofhe.mocks.expectPlaintext(await token.confidentialBalanceOf(bob), 1n);
  });

  it("shields, unshields and claims through the proxy", async function () {
    const { token, wBTC, bob, alice } = await deployERC20Wrapper();
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);

    const shieldValue = BigInt(1e8);
    const confidentialValue = shieldValue / rate; // 1e6

    await wBTC.mint(bob, shieldValue);
    await wBTC.connect(bob).approve(token.target, shieldValue);
    await token.connect(bob).shield(bob, shieldValue);
    await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), confidentialValue);

    const tx = await token
      .connect(bob)
      ["unshield(address,address,uint64)"](bob.address, alice.address, confidentialValue);
    const { ctHash, claimId } = await getUnshieldRequest(tx, token, alice.address);

    // Time travel past decryption delay
    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

    await token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature);
    expect(await wBTC.balanceOf(alice.address)).to.equal(shieldValue);
    expect(await wBTC.balanceOf(token.target)).to.equal(0n);
  });

  it("keeps the shielded supply across an upgrade", async function () {
    const { token, factory, wBTC, owner, bob } = await deployERC20Wrapper();

    const shieldValue = BigInt(1e8);
    await wBTC.mint(bob, shieldValue);
    await wBTC.connect(bob).approve(token.target, shieldValue);
    await token.connect(bob).shield(bob, shieldValue);

    const next = await factory.deploy();
    await next.waitForDeployment();
    await token.connect(owner).upgradeToAndCall(await next.getAddress(), "0x");

    await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), shieldValue / rate);
    expect(await token.inferredTotalSupply()).to.equal(shieldValue / rate);
  });

  shouldGateUpgrades(deployERC20Wrapper);
});

describe("FHERC20NativeWrapperUUPS", function () {
  // wETH has 18 decimals: rate = 1e12, confidential decimals = 6
  const rate = 1_000_000_000_000n;

  it("initializes through the proxy", async function () {
    const { token, wETH, owner } = await deployNativeWrapper();

    expect(await token.name()).to.equal("FHERC20 Wrapped ETH");
    expect(await token.symbol()).to.equal("eETH");
    expect(await token.decimals()).to.equal(6);
    expect(await token.contractURI()).to.equal("https://example.com/eeth.json");
    expect(await token.weth()).to.equal(await wETH.getAddress());
    expect(await token.rate()).to.equal(rate);
    expect(await token.owner()).to.equal(owner.address);
    // Sized from the capped 6 decimals. wETH's 18 would give 1e14.
    expect(await token.indicatorTick()).to.equal(100n);
  });

  it("cannot be initialized twice, nor on the implementation", async function () {
    const { token, impl, wETH, bob } = await deployNativeWrapper();
    const weth = await wETH.getAddress();

    await expect(token.initialize(weth, "X", "X", "", bob.address)).to.be.revertedWithCustomError(
      token,
      "InvalidInitialization",
    );
    await expect(impl.initialize(weth, "X", "X", "", bob.address)).to.be.revertedWithCustomError(
      impl,
      "InvalidInitialization",
    );
  });

  it("shields native value, unshields and claims through the proxy", async function () {
    const { token, bob, alice } = await deployNativeWrapper();
    const bobClient = await hre.cofhe.createClientWithBatteries(bob);

    const shieldValue = ethers.parseEther("1");
    const confidentialValue = shieldValue / rate; // 1e6

    await token.connect(bob).shieldNative(bob, { value: shieldValue });
    await hre.cofhe.mocks.expectPlaintext(await token.confidentialTotalSupply(), confidentialValue);
    expect(await ethers.provider.getBalance(token.target)).to.equal(shieldValue);

    const tx = await token
      .connect(bob)
      ["unshield(address,address,uint64)"](bob.address, alice.address, confidentialValue);
    const { ctHash, claimId } = await getUnshieldRequest(tx, token, alice.address);

    // Time travel past decryption delay
    await hre.network.provider.send("evm_increaseTime", [11]);
    await hre.network.provider.send("evm_mine");
    const decryption = await bobClient.decryptForTx(ctHash).withoutACP().execute();

    await expect(
      token.connect(bob).claimUnshielded(claimId, decryption.decryptedValue, decryption.signature),
    ).to.changeEtherBalance(alice, shieldValue);
    expect(await ethers.provider.getBalance(token.target)).to.equal(0n);
  });

  shouldGateUpgrades(deployNativeWrapper);
});
