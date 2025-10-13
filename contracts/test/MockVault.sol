// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20 } from "../FHERC20.sol";
import { IFHERC20 } from "../interfaces/IFHERC20.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";

contract MockVault {
    FHERC20 public immutable asset;
    mapping(address => euint64) public balances;

    constructor(address _asset) {
        require(_asset != address(0), "Invalid asset");
        asset = FHERC20(_asset);
    }

    function deposit(InEuint64 calldata inAmount) external {
        euint64 amount = FHE.asEuint64(inAmount);
        FHE.allow(amount, address(asset));
        euint64 transferred = asset.confidentialTransferFrom(msg.sender, address(this), amount);
        (, euint64 updated) = FHESafeMath.tryAdd(balances[msg.sender], transferred);
        balances[msg.sender] = updated;
    }

    function withdraw(InEuint64 calldata inAmount) external {
        euint64 amount = FHE.asEuint64(inAmount);
        (, euint64 updated) = FHESafeMath.trySub(balances[msg.sender], amount);
        balances[msg.sender] = updated;
    }
}
