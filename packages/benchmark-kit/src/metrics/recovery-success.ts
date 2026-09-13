import type { BenchmarkTrialArm } from "../../contracts/trial.contract.js";

/**
 * Derive the benchmark recovery outcome from the intervention and the native
 * terminal oracle. Gate convergence alone is never task success.
 *
 * `null` means that no recovery was attempted (or that the arm cannot recover).
 * Once A3 has retried, failure to reach a passing Harbor verifier is `false`,
 * including gate exhaustion where the verifier is intentionally absent.
 */
export function deriveRecoverySuccessful(
  arm: BenchmarkTrialArm,
  recoveryAttempts: number,
  terminalVerifierPassed: boolean | null,
): boolean | null {
  if (arm !== "A3_recovering" || recoveryAttempts === 0) return null;
  return terminalVerifierPassed === true;
}
