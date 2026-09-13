import assert from "node:assert/strict";
import test from "node:test";

import { deriveRecoverySuccessful } from "../src/metrics/recovery-success.js";

test("recovery success requires an A3 retry and a passing terminal Harbor verifier", () => {
  assert.equal(deriveRecoverySuccessful("A3_recovering", 2, true), true);
  assert.equal(deriveRecoverySuccessful("A3_recovering", 2, false), false);
  assert.equal(deriveRecoverySuccessful("A3_recovering", 3, null), false);
  assert.equal(deriveRecoverySuccessful("A3_recovering", 0, true), null);
  assert.equal(deriveRecoverySuccessful("A2_blocking", 1, true), null);
});

test("MUTATION: gate convergence cannot counterfeit recovery success", () => {
  const gateEventuallyPassed = true;
  const harborVerifierPassed = false;
  assert.equal(gateEventuallyPassed, true);
  assert.equal(
    deriveRecoverySuccessful("A3_recovering", 2, harborVerifierPassed),
    false,
  );
});
