import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const LIB_FQN = "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib";

/**
 * Deploys AND VERIFIES ERC20ConfidentialLib - the shared confidential engine.
 *
 * Deploy ONCE PER CHAIN; every confidential token (thin hosts, wrappers, Core-based products)
 * links against this single instance. Idempotent: hardhat-deploy skips the deployment when the
 * library is already deployed on the target network with identical bytecode, and records the
 * address in `deployments/<network>/ERC20ConfidentialLib.json` - that file is the on-repo
 * address registry that later deploy scripts (and frontends) read. COMMIT IT.
 *
 * Verification is FORCED on live networks: the script refuses to deploy unless
 * `ETHERSCAN_MAINNET_API_KEY` is set in the environment (users must be able to read the
 * library code on the block explorer), and verifies right after deployment. On dev networks
 * (hardhat/localhost) verification is skipped. If verification fails after a successful
 * deployment, the script exits with an error - re-running it retries verification only
 * (the deployment itself is skipped as already done).
 *
 *   ETHERSCAN_MAINNET_API_KEY=... npx hardhat deploy --network <network> --tags ERC20ConfidentialLib
 *
 * NOTE: the library's compiler settings are pinned in hardhat.config.ts (0.8.26, optimizer
 * runs:1) so this artifact is reproducible for explorer verification. Don't retune those
 * settings without redeploying and re-verifying. The 1.0.0 (audited) library source differs
 * from every 0.x build, so library instances deployed from 0.x must not be reused: deploy a
 * fresh instance per chain for 1.0.0 hosts.
 *
 * How a token links against it (the address is baked into the token's BYTECODE at deploy
 * time - it is not a constructor argument and cannot change afterwards):
 *
 *   // hardhat-deploy style (in a later deploy script):
 *   const lib = await deployments.get("ERC20ConfidentialLib");
 *   await deploy("MyConfidentialToken", {
 *     from: deployer,
 *     args: [...],
 *     libraries: { ERC20ConfidentialLib: lib.address },
 *   });
 *
 *   // plain ethers style (tests / scripts):
 *   const factory = await ethers.getContractFactory("MyConfidentialToken", {
 *     libraries: { "contracts/ERC20Confidential/ERC20ConfidentialLib.sol:ERC20ConfidentialLib": lib.address },
 *   });
 *
 *   // OZ upgrades plugin (upgradeable tokens):
 *   await upgrades.deployProxy(factory, [...], { unsafeAllowLinkedLibraries: true });
 */
const deployConfidentialLib: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy, log } = hre.deployments;

  // Forced-verification precondition. Fail BEFORE deploying: we never want an unverifiable
  // library on a live chain. (process.env is checked directly, not the hardhat config value,
  // because the config carries a shared fallback key that must not be relied on for
  // production verification.)
  if (hre.network.live && !process.env.ETHERSCAN_MAINNET_API_KEY) {
    throw new Error(
      `Refusing to deploy ERC20ConfidentialLib to '${hre.network.name}' without explorer verification.\n` +
        `Set ETHERSCAN_MAINNET_API_KEY in your environment (or .env) and re-run - every deployed\n` +
        `library must have its source readable on the block explorer.`,
    );
  }

  const lib = await deploy("ERC20ConfidentialLib", {
    contract: LIB_FQN,
    from: deployer,
    log: true,
    // Give the explorer time to index the deployment tx before we ask it to verify.
    waitConfirmations: hre.network.live ? 5 : 1,
  });

  if (lib.newlyDeployed) {
    log(`ERC20ConfidentialLib deployed at ${lib.address} on '${hre.network.name}'`);
  } else {
    log(`ERC20ConfidentialLib already deployed at ${lib.address} on '${hre.network.name}' (deployment skipped)`);
  }

  if (!hre.network.live) {
    log(`dev network '${hre.network.name}' - explorer verification skipped`);
    return;
  }

  log(`verifying ERC20ConfidentialLib at ${lib.address} ...`);
  try {
    await hre.run("verify:verify", { address: lib.address, contract: LIB_FQN });
    log(`verified: ERC20ConfidentialLib at ${lib.address}`);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    if (/already.{0,10}verified/i.test(message)) {
      log(`ERC20ConfidentialLib at ${lib.address} is already verified`);
      return;
    }
    throw new Error(
      `ERC20ConfidentialLib deployed at ${lib.address} but explorer verification FAILED:\n${message}\n` +
        `Re-run this script to retry verification (the deployment step will be skipped).`,
    );
  }
};

deployConfidentialLib.tags = ["ERC20ConfidentialLib", "lib"];
export default deployConfidentialLib;
