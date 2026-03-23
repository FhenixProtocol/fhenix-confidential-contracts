// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, InEuint64, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { ERC7984 } from "../ERC7984/ERC7984.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";

contract MockERC7984Vault {
    ERC7984 public immutable asset;
    mapping(address => euint64) public balances;

    constructor(address _asset) {
        require(_asset != address(0), "Invalid asset");
        asset = ERC7984(_asset);
    }

    function deposit(InEuint64 calldata inAmount) external {
        euint64 amount = FHE.asEuint64(inAmount);
        FHE.allow(amount, address(asset));
        euint64 transferred = asset.confidentialTransferFrom(msg.sender, address(this), amount);
        (, euint64 updated) = FHESafeMath.tryAdd(balances[msg.sender], transferred);
        balances[msg.sender] = updated;
    }
}
