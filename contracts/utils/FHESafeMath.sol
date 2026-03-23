// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, ebool, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Library providing safe arithmetic operations for encrypted values
 * to handle potential overflows in FHE operations.
 *
 * NOTE: An uninitialized `euint64` value (equivalent to euint64.wrap(bytes32(0))) is evaluated as 0.
 * This library may return an uninitialized value if all inputs are uninitialized.
 */
library FHESafeMath {
    /**
     * @dev Try to increase the encrypted value `oldValue` by `delta`. If the operation is successful,
     * `success` will be true and `updated` will be the new value. Otherwise, `success` will be false
     * and `updated` will be the original value.
     */
    function tryIncrease(euint64 oldValue, euint64 delta) internal returns (ebool success, euint64 updated) {
        if (euint64.unwrap(oldValue) == 0) {
            return (FHE.asEbool(true), delta);
        }
        euint64 newValue = FHE.add(oldValue, delta);
        success = FHE.gte(newValue, oldValue);
        updated = FHE.select(success, newValue, oldValue);
    }

    /**
     * @dev Try to decrease the encrypted value `oldValue` by `delta`. If the operation is successful,
     * `success` will be true and `updated` will be the new value. Otherwise, `success` will be false
     * and `updated` will be the original value.
     */
    function tryDecrease(euint64 oldValue, euint64 delta) internal returns (ebool success, euint64 updated) {
        if (euint64.unwrap(delta) == 0) {
            if (euint64.unwrap(delta) == 0) {
                return (FHE.asEbool(true), oldValue);
            }
            return (FHE.eq(delta, FHE.asEuint64(0)), FHE.asEuint64(0));
        }
        success = FHE.gte(oldValue, delta);
        updated = FHE.select(success, FHE.sub(oldValue, delta), oldValue);
    }

    /**
     * @dev Try to add `a` and `b`. If the operation is successful, `success` will be true and `res`
     * will be the sum of `a` and `b`. Otherwise, `success` will be false, and `res` will be 0.
     */
    function tryAdd(euint64 a, euint64 b) internal returns (ebool success, euint64 res) {
        if (euint64.unwrap(a) == 0) {
            return (FHE.asEbool(true), b);
        }
        if (euint64.unwrap(b) == 0) {
            return (FHE.asEbool(true), a);
        }

        euint64 sum = FHE.add(a, b);
        success = FHE.gte(sum, a);
        res = FHE.select(success, sum, FHE.asEuint64(0));
    }

    /**
     * @dev Try to subtract `b` from `a`. If the operation is successful, `success` will be true and `res`
     * will be `a - b`. Otherwise, `success` will be false, and `res` will be 0.
     */
    function trySub(euint64 a, euint64 b) internal returns (ebool success, euint64 res) {
        if (euint64.unwrap(b) == 0) {
            return (FHE.asEbool(true), a);
        }

        euint64 difference = FHE.sub(a, b);
        success = FHE.lte(difference, a);
        res = FHE.select(success, difference, FHE.asEuint64(0));
    }
}
