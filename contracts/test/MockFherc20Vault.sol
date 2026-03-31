// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, InEuint64, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";
import { FHERC20 } from "../FHERC20/FHERC20.sol";
import { FHESafeMath } from "../utils/FHESafeMath.sol";

contract MockFHERC20Vault {
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
}
