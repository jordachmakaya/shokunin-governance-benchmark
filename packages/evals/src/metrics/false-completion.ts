/**
 * ZB3 — False completion metrics.
 *
 * Derives falseCompletionTerminal rate from BenchmarkTrial records.
 * NEVER computes falseCompletionInitial or falseCompletionIntercepted
 * until snapshot verification parity is proven (§4.3 of Master Plan).
 */

import type { BenchmarkTrial } from "@shokunin/benchmark-kit";

/**
 * Compute falseCompletionTerminal rate for a set of trials.
 *
 * Rules:
 * - Only trials where metrics.falseCompletionTerminal is non-null count.
 * - Returns null if no qualifying trials exist (all null).
 * - Rate = count(falseCompletionTerminal === true) / count(non-null).
 */
export function computeFalseCompletionTerminalRate(
  trials: readonly BenchmarkTrial[],
): number | null {
  const qualifying = trials.filter((t) => t.metrics.falseCompletionTerminal !== null);
  if (qualifying.length === 0) return null;
  const falseCount = qualifying.filter((t) => t.metrics.falseCompletionTerminal === true).length;
  return falseCount / qualifying.length;
}

/**
 * Compute gate detection rate (A1 arm only): fraction of claims in A1 trials
 * where gateVerdict === 'BLOCK'.
 *
 * Returns null for non-A1 trials or if no claims exist.
 */
export function computeGateDetectionRate(
  trials: readonly BenchmarkTrial[],
): number | null {
  const a1Trials = trials.filter((t) => t.arm === "A1_observing");
  if (a1Trials.length === 0) return null;

  let totalClaims = 0;
  let blockCount = 0;
  for (const t of a1Trials) {
    for (const claim of t.execution.claims) {
      totalClaims++;
      if (claim.gateVerdict === "BLOCK") blockCount++;
    }
  }
  if (totalClaims === 0) return null;
  return blockCount / totalClaims;
}

/**
 * Compute false completion intercepted rate for A2/A3 arms:
 * fraction of trials where metrics.falseCompletionIntercepted === true.
 *
 * Returns null if no qualifying trials (all null) or wrong arm.
 */
export function computeFalseCompletionInterceptedRate(
  trials: readonly BenchmarkTrial[],
): number | null {
  const qualifying = trials.filter(
    (t) =>
      (t.arm === "A2_blocking" || t.arm === "A3_recovering") &&
      t.metrics.falseCompletionIntercepted !== null,
  );
  if (qualifying.length === 0) return null;
  const interceptedCount = qualifying.filter(
    (t) => t.metrics.falseCompletionIntercepted === true,
  ).length;
  return interceptedCount / qualifying.length;
}

/**
 * Compute recovery success rate (A3 arm only):
 * fraction of A3 trials where recoverySuccessful === true.
 *
 * Returns null for non-A3 trials or if all recoverySuccessful are null.
 */
export function computeRecoverySuccessRate(
  trials: readonly BenchmarkTrial[],
): number | null {
  const a3Trials = trials.filter((t) => t.arm === "A3_recovering");
  const qualifying = a3Trials.filter((t) => t.metrics.recoverySuccessful !== null);
  if (qualifying.length === 0) return null;
  const successCount = qualifying.filter(
    (t) => t.metrics.recoverySuccessful === true,
  ).length;
  return successCount / qualifying.length;
}
