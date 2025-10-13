import { expect } from "chai";
import { ERC20, FHERC20, IFHERC20 } from "../typechain-types";
import hre, { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { TypedDataDomain } from "ethers";

// LOGS

export const logState = (state: string) => {
  console.log("Encrypt State - ", state);
};

export const nullLogState = () => null;

// TICKS

export const ticksToIndicated = async (token: FHERC20, ticks: bigint): Promise<bigint> => {
  const tick = await token.indicatorTick();
  return ticks * BigInt(tick);
};

export const tick = async (token: FHERC20): Promise<bigint> => {
  return token.indicatorTick();
};

// BALANCES

const indicatedBalances = new Map<string, bigint>();
const encBalances = new Map<string, bigint>();

export const prepExpectFHERC20BalancesChange = async (token: FHERC20, account: string) => {
  indicatedBalances.set(account, await token.balanceOf(account));
  const encBalanceHash = await token.confidentialBalanceOf(account);
  const encBalance = await hre.cofhe.mocks.getPlaintext(encBalanceHash);
  encBalances.set(account, encBalance);
};

export const expectFHERC20BalancesChange = async (
  token: FHERC20,
  account: string,
  expectedIndicatedChange: bigint,
  expectedEncChange: bigint,
) => {
  const symbol = await token.symbol();

  const currIndicated = await token.balanceOf(account);
  const prevIndicated = indicatedBalances.get(account)!;
  const indicatedChange = currIndicated - prevIndicated;
  expect(indicatedChange).to.equal(
    expectedIndicatedChange,
    `${symbol} (FHERC20) indicated balance change for ${account} is incorrect. Expected: ${expectedIndicatedChange}, received: ${indicatedChange}`,
  );

  const currEncBalanceHash = await token.confidentialBalanceOf(account);
  const currEncBalance = await hre.cofhe.mocks.getPlaintext(currEncBalanceHash);
  const prevEncBalance = encBalances.get(account)!;
  const encChange = currEncBalance - prevEncBalance;
  expect(encChange).to.equal(
    expectedEncChange,
    `${symbol} (FHERC20) encrypted balance change for ${account} is incorrect. Expected: ${expectedEncChange}, received: ${encChange}`,
  );
};

const erc20Balances = new Map<string, bigint>();

export const prepExpectERC20BalancesChange = async (token: ERC20, account: string) => {
  erc20Balances.set(account, await token.balanceOf(account));
};

export const expectERC20BalancesChange = async (token: ERC20, account: string, expectedChange: bigint) => {
  const symbol = await token.symbol();

  const currBal = await token.balanceOf(account);
  const prevBal = erc20Balances.get(account)!;
  const delta = currBal - prevBal;
  expect(delta).to.equal(
    expectedChange,
    `${symbol} (ERC20) balance change for ${account} is incorrect. Expected: ${expectedChange}, received: ${delta}`,
  );
};

// Operator Permit
type GeneratePermitOptions = {
  signer: HardhatEthersSigner;
  token: FHERC20;
  owner: string;
  spender: string;
  until: number | bigint;
  nonce?: bigint;
  deadline?: bigint;
};

export const getNowTimestamp = () => {
  return BigInt(Date.now()) / 1000n;
};

export const generateTransferFromPermit = async (options: GeneratePermitOptions) => {
  let { token, signer, owner, spender, until, nonce, deadline } = options;

  const { name, version, chainId, verifyingContract } = await token.eip712Domain();

  // If nonce is not provided, get it from the token
  if (nonce == null) nonce = await token.nonces(owner);

  // If deadline is not provided, set it to 24 hours from now
  if (deadline == null) deadline = getNowTimestamp() + BigInt(24 * 60 * 60);

  const domain: TypedDataDomain = {
    name,
    version,
    chainId,
    verifyingContract,
  };

  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "until", type: "uint48" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  const message = {
    owner,
    spender,
    until,
    nonce,
    deadline,
  };

  const signature = await signer.signTypedData(domain, types, message);
  const { v, r, s } = ethers.Signature.from(signature);

  return {
    owner,
    spender,
    until,
    deadline,
    v,
    r,
    s,
  };
};
