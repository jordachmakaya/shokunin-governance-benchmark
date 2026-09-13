/**
 * ZB3 — Per-arm aggregation.
 *
 * Computes ArmSuccessMetrics from a set of included trials (post-attrition).
 */

import type { BenchmarkTrial, BenchmarkTrialArm } from "@shokunin/benchmark-kit";
import type { ArmSuccessMetrics, AttritionRecord } from "../../contracts/evals.contract.js";
import {
  computeFalseCompletionTerminalRate,
  computeGateDetectionRate,
  computeFalseCompletionInterceptedRate,
  computeRecoverySuccessRate,
} from "../metrics/false-completion.js";

// ---------------------------------------------------------------------------
// Median computation (deterministic — sorted)
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function meanOrNull(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) return null;
  return defined.reduce((s, v) => s + v, 0) / defined.length;
}

// ---------------------------------------------------------------------------
// Arm metrics computation
// ---------------------------------------------------------------------------

const ALL_ARMS: BenchmarkTrialArm[] = [
  "A0_baseline",
  "A1_observing",
  "A2_blocking",
  "A3_recovering",
];

export function computeArmMetrics(
  includedByArm: ReadonlyMap<BenchmarkTrialArm, readonly BenchmarkTrial[]>,
  attrition: readonly AttritionRecord[],
  allTrials: readonly BenchmarkTrial[],
): readonly ArmSuccessMetrics[] {
  const results: ArmSuccessMetrics[] = [];

  for (const arm of ALL_ARMS) {
    const included = includedByArm.get(arm) ?? [];
    if (included.length === 0 && allTrials.filter((t) => t.arm === arm).length === 0) {
      // Arm was never assigned — skip
      continue;
    }

    const excluded = attrition.filter((a) => a.arm === arm).length;
    const trialsIncluded = included.length;

    // Success rate
    const successCount = included.filter((t) => t.verifier?.passed === true).length;
    const successRate = trialsIncluded > 0 ? successCount / trialsIncluded : 0;

    // False completion terminal rate (only from Harbor verdict — qualified)
    const falseCompletionTerminalRate = computeFalseCompletionTerminalRate(included);

    // Token/cost usage (nullable — only non-null values contribute)
    const meanInputTokens = meanOrNull(included.map((t) => t.usage.inputTokens));
    const meanOutputTokens = meanOrNull(included.map((t) => t.usage.outputTokens));
    const meanCostUsd = meanOrNull(included.map((t) => t.usage.costUsd));

    // Duration median (always non-null per contract)
    const medianDurationMs = median(included.map((t) => t.usage.durationMs));

    // Arm-specific rates
    const gateDetectionRate =
      arm === "A1_observing" ? computeGateDetectionRate(included) : null;
    // Recovery is an intervention-level metric. A3 attempts that exhaust the
    // gate are governance attrition for primary efficacy, but they remain
    // failed recoveries and must stay in this denominator.
    const recoverySuccessRate =
      arm === "A3_recovering" ? computeRecoverySuccessRate(allTrials) : null;
    const falseCompletionInterceptedRate =
      arm === "A2_blocking" || arm === "A3_recovering"
        ? computeFalseCompletionInterceptedRate(included)
        : null;

    results.push({
      arm,
      trialsIncluded,
      trialsExcluded: excluded,
      successRate,
      falseCompletionTerminalRate,
      meanInputTokens,
      meanOutputTokens,
      meanCostUsd,
      medianDurationMs,
      gateDetectionRate,
      recoverySuccessRate,
      falseCompletionInterceptedRate,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Intention-to-treat
// ---------------------------------------------------------------------------

import type { AttritionReason, IntentionToTreatResult } from "../../contracts/evals.contract.js";

export function computeIntentionToTreat(
  allTrials: readonly BenchmarkTrial[],
  attrition: readonly AttritionRecord[],
): readonly IntentionToTreatResult[] {
  const results: IntentionToTreatResult[] = [];

  for (const arm of ALL_ARMS) {
    const assigned = allTrials.filter((t) => t.arm === arm);
    if (assigned.length === 0) continue;

    // ITT: infrastructure failures count as failures (not excluded)
    const successCount = assigned.filter((t) => t.verifier?.passed === true).length;
    const successRate = successCount / assigned.length;

    const armAttrition = attrition.filter((a) => a.arm === arm);
    const attritionRate = armAttrition.length / assigned.length;

    const byReason = new Map<AttritionReason, number>();
    for (const rec of armAttrition) {
      byReason.set(rec.reason, (byReason.get(rec.reason) ?? 0) + 1);
    }

    results.push({
      arm,
      totalTrialsAssigned: assigned.length,
      successRate,
      attritionRate,
      attritionByReason: byReason as ReadonlyMap<AttritionReason, number>,
    });
  }

  return results;
}
