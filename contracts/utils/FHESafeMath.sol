// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import { FHE, ebool, euint64 } from "@fhenixprotocol/cofhe-contracts/FHE.sol";

/**
 * @dev Library providing safe arithmetic operations for encrypted values
 * to handle potential overflows in FHE operations.
 *
 * NOTE: An uninitialized `euint64` value is evaluated as 0.
 * This library may return an uninitialized value if all inputs are uninitialized.
 */
library FHESafeMath {
    /**
     * @dev Try to increase the encrypted value `oldValue` by `delta`. If the operation is successful,
     * `success` will be true and `updated` will be the new value. Otherwise, `success` will be false
     * and `updated` will be the original value.
     */
    function tryIncrease(euint64 oldValue, euint64 delta) internal returns (ebool success, euint64 updated) {
        if (!FHE.isInitialized(oldValue)) {
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
        if (!FHE.isInitialized(oldValue)) {
            if (!FHE.isInitialized(delta)) {
                return (FHE.asEbool(true), oldValue);
            }
            return (FHE.eq(delta, FHE.asEuint64(0)), FHE.asEuint64(0));
        }
        success = FHE.gte(oldValue, delta);
        updated = FHE.select(success, FHE.sub(oldValue, delta), oldValue);
    }

    /**
     * @dev Saturating debit of `amount` from `balance`, all-or-nothing: the amount is removed only
     * if it fully fits. Returns the post-debit `balance` AND `spent`, the amount actually removed
     * (`amount` on success, 0 otherwise), so a caller crediting a counterparty can use `spent`
     * directly instead of re-deriving it with a second `FHE.select` on `amount`.
     *
     * Same semantics as {tryDecrease} — on failure `balance` is left untouched, never partially
     * drained — but one FHE op cheaper for the transfer pattern: selecting the delta first lets a
     * single `FHE.sub` stand in for {tryDecrease}'s `FHE.sub` + `FHE.select` pair, and the caller's
     * own `FHE.select` disappears. `spent` is always an initialized, caller-owned handle, so it is
     * safe to `FHE.allow` and to feed into further FHE ops.
     */
    function trySpend(
        euint64 balance,
        euint64 amount
    ) internal returns (ebool success, euint64 updated, euint64 spent) {
        if (!FHE.isInitialized(balance)) {
            // Nothing to spend from: the debit can only succeed for a zero `amount`, and either
            // way both outputs are 0. One trivially-encrypted zero serves as all three handles.
            euint64 zero = FHE.asEuint64(0);
            if (!FHE.isInitialized(amount)) return (FHE.asEbool(true), zero, zero);
            return (FHE.eq(amount, zero), zero, zero);
        }

        success = FHE.gte(balance, amount);
        spent = FHE.select(success, amount, FHE.asEuint64(0));
        // `spent` is `amount` only when it fits, 0 otherwise, so this can never underflow.
        updated = FHE.sub(balance, spent);
    }

    /**
     * @dev Try to add `a` and `b`. If the operation is successful, `success` will be true and `res`
     * will be the sum of `a` and `b`. Otherwise, `success` will be false, and `res` will be 0.
     */
    function tryAdd(euint64 a, euint64 b) internal returns (ebool success, euint64 res) {
        if (!FHE.isInitialized(a)) {
            return (FHE.asEbool(true), b);
        }
        if (!FHE.isInitialized(b)) {
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
        if (!FHE.isInitialized(a)) {
            if (!FHE.isInitialized(b)) {
                return (FHE.asEbool(true), a);
            }
            return (FHE.eq(b, FHE.asEuint64(0)), FHE.asEuint64(0));
        }
        if (!FHE.isInitialized(b)) {
            return (FHE.asEbool(true), a);
        }

        euint64 difference = FHE.sub(a, b);
        success = FHE.lte(difference, a);
        res = FHE.select(success, difference, FHE.asEuint64(0));
    }
}
