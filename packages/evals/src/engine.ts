/**
 * ZB3 — EvalsEngine: the main implementation of IEvalsEngine.
 *
 * Orchestrates: attrition → arm metrics → bootstrap BCa → ITT → sensitivity.
 */

import { createHash } from "node:crypto";
import { benchmarkTrialSchema, type BenchmarkTrial, type BenchmarkTrialArm } from "@shokunin/benchmark-kit";
import type {
  IEvalsEngine,
  EvalReport,
  ArmSuccessMetrics,
  AttritionRecord,
  BcaBootstrapConfig,
  PairedComparisonResult,
  SensitivityAnalysisResult,
} from "../contracts/evals.contract.js";
import { ActionableEvalsError } from "../contracts/errors.contract.js";
import { bcaBootstrapConfigSchema } from "../schemas/evals-report.schema.js";
import {
  buildAttritionLedger,
  extractMatchedPairs,
} from "./attrition/attrition.js";
import { computeArmMetrics, computeIntentionToTreat } from "./aggregation/arm-aggregation.js";
import { computeBootstrapPairedDelta } from "./statistics/bootstrap-analysis.js";

const TREATMENT_ARMS: BenchmarkTrialArm[] = [
  "A1_observing",
  "A2_blocking",
  "A3_recovering",
];

export class EvalsEngine implements IEvalsEngine {
  // ---------------------------------------------------------------------------
  // Public: full report
  // ---------------------------------------------------------------------------

  async computeReport(
    trials: readonly BenchmarkTrial[],
    config: BcaBootstrapConfig,
  ): Promise<EvalReport> {
    // 1. Validate config
    const configResult = bcaBootstrapConfigSchema.safeParse(config);
    if (!configResult.success) {
      throw new ActionableEvalsError({
        code: "CONFIG_INVALID",
        message: `Bootstrap config is invalid: ${configResult.error.message}`,
        remediation: "Provide a BcaBootstrapConfig with resamples >= 10000, confidenceLevel in (0,1), and alternative 'two-sided'.",
        retryable: false,
        details: { issues: configResult.error.issues },
      });
    }

    // 2. Validate trials input
    this._validateTrials(trials);

    // 3. Extract metadata from first trial
    const first = trials[0]!;
    const experimentId = first.experimentId;
    const hypothesisId = first.hypothesisId;
    const campaignId = first.campaignId;

    // 4. Build attrition ledger (paired analysis against A0)
    const { included, attrition } = buildAttritionLedger(trials, "A0_baseline");

    // 5. Per-arm metrics
    const armMetrics = computeArmMetrics(included, attrition, trials);

    // 6. Bootstrap paired comparisons (treatment vs A0)
    const pairedComparisons = new Map<string, PairedComparisonResult>();
    for (const arm of TREATMENT_ARMS) {
      const pairs = extractMatchedPairs(included, "A0_baseline", arm);
      if (pairs.length > 0) {
        const result = computeBootstrapPairedDelta(pairs, config);
        pairedComparisons.set(`${arm}_vs_A0_baseline`, result);
      }
    }

    // 7. Intention-to-treat
    const intentionToTreat = computeIntentionToTreat(trials, attrition);

    // 8. Sensitivity analysis (with vs without infrastructure failures)
    const sensitivityAnalysis = new Map<string, SensitivityAnalysisResult>();
    for (const arm of TREATMENT_ARMS) {
      // Excluding infra failures from primary attrition (already done)
      const pairsExcluding = extractMatchedPairs(included, "A0_baseline", arm);
      if (pairsExcluding.length === 0) continue;

      // Including infra failures: rebuild attrition with no infrastructure exclusion
      const { included: includedWithInfra } = buildAttritionLedger(
        trials.filter((t) => t.failureClassification !== "EXOGENOUS_INFRASTRUCTURE_FAILURE"),
        "A0_baseline",
      );
      // Treat infra-failed trials as failures by adding them back with verifier.passed=false
      // They are already in trials array — rebuild including them
      const { included: includedAll } = buildAttritionLedgerIncludingInfra(trials);
      const pairsIncluding = extractMatchedPairs(includedAll, "A0_baseline", arm);

      if (pairsIncluding.length === 0) continue;

      const excludingResult = computeBootstrapPairedDelta(pairsExcluding, config);
      const includingResult = computeBootstrapPairedDelta(pairsIncluding, config);

      sensitivityAnalysis.set(`${arm}_vs_A0_baseline`, {
        excludingInfraFailures: excludingResult,
        includingInfraFailures: includingResult,
      });
    }

    return {
      schemaVersion: "1.0.0",
      experimentId,
      hypothesisId,
      campaignId,
      generatedAt: new Date().toISOString(),
      trialsInput: trials.length,
      bootstrapConfig: config,
      armMetrics,
      attrition,
      pairedComparisons,
      intentionToTreat,
      sensitivityAnalysis,
    };
  }

  // ---------------------------------------------------------------------------
  // Public: fast-path arm metrics
  // ---------------------------------------------------------------------------

  computeArmMetrics(trials: readonly BenchmarkTrial[]): readonly ArmSuccessMetrics[] {
    this._validateTrials(trials);
    const { included, attrition } = buildAttritionLedger(trials, null);
    return computeArmMetrics(included, attrition, trials);
  }

  // ---------------------------------------------------------------------------
  // Public: attrition ledger only
  // ---------------------------------------------------------------------------

  computeAttrition(trials: readonly BenchmarkTrial[]): readonly AttritionRecord[] {
    this._validateTrials(trials);
    const { attrition } = buildAttritionLedger(trials, "A0_baseline");
    return attrition;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _validateTrials(trials: readonly BenchmarkTrial[]): void {
    if (trials.length === 0) {
      throw new ActionableEvalsError({
        code: "INPUT_INVALID",
        message: "Trials array is empty.",
        remediation: "Provide at least one BenchmarkTrial record.",
        retryable: false,
      });
    }

    const firstCandidate: unknown = trials[0];
    if (firstCandidate === null || typeof firstCandidate !== "object") {
      throw new ActionableEvalsError({
        code: "INPUT_INVALID",
        message: "The trials input contains a non-object record.",
        remediation: "Provide schema-valid BenchmarkTrial records produced by ZB2.",
        retryable: false,
      });
    }

    // Validate consistent experimentId/hypothesisId/campaignId
    const experimentId = trials[0]!.experimentId;
    const hypothesisId = trials[0]!.hypothesisId;
    const campaignId = trials[0]!.campaignId;
    const trialIds = new Set<string>();

    for (const t of trials) {
      const candidate: unknown = t;
      const safeTrialId =
        candidate !== null && typeof candidate === "object" && "trialId" in candidate
          ? String((candidate as { trialId: unknown }).trialId)
          : "<unknown>";
      try {
        benchmarkTrialSchema.parse(candidate);
      } catch (error) {
        throw new ActionableEvalsError({
          code: "INPUT_INVALID",
          message: `Trial "${safeTrialId}" does not satisfy the frozen ZB2 BenchmarkTrial schema.`,
          remediation: "Provide schema-valid BenchmarkTrial records produced by ZB2.",
          retryable: false,
          details: { trialId: safeTrialId, cause: error instanceof Error ? error.message : String(error) },
        });
      }
      if (trialIds.has(t.trialId)) {
        throw new ActionableEvalsError({
          code: "INPUT_INVALID",
          message: `Duplicate trialId: "${t.trialId}".`,
          remediation: "Every BenchmarkTrial must have a globally unique trialId.",
          retryable: false,
          details: { trialId: t.trialId },
        });
      }
      trialIds.add(t.trialId);
      if (
        t.experimentId !== experimentId ||
        t.hypothesisId !== hypothesisId ||
        t.campaignId !== campaignId
      ) {
        throw new ActionableEvalsError({
          code: "INPUT_INVALID",
          message: `Trials span multiple experiments, hypotheses, or campaigns. Expected experimentId="${experimentId}", hypothesisId="${hypothesisId}", campaignId="${campaignId}"; got experimentId="${t.experimentId}", hypothesisId="${t.hypothesisId}", campaignId="${t.campaignId}" in trial "${t.trialId}".`,
          remediation: "Pass only trials from a single experiment, hypothesis, and campaign per computeReport call.",
          retryable: false,
          details: { trialId: t.trialId },
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sensitivity helper: include infra failures as failed trials
// ---------------------------------------------------------------------------

/**
 * Builds attrition ledger treating infrastructure failures as ordinary failures
 * (not excluded) — used for sensitivity analysis.
 */
function buildAttritionLedgerIncludingInfra(
  trials: readonly BenchmarkTrial[],
) {
  // Override: only exclude AGENT_RUNTIME_FAILURE, VERIFIER_FAILURE, GOVERNANCE_FAILURE
  const modifiedTrials = trials.map((t): BenchmarkTrial => {
    if (t.failureClassification === "EXOGENOUS_INFRASTRUCTURE_FAILURE") {
      // Treat as a failed trial — set failureClassification to null and verifier to null
      // so deriveAttritionReason returns null (included) and verifier.passed = false (no verifier)
      // We cannot mutate BenchmarkTrial (readonly), so we shadow it
      return {
        ...t,
        failureClassification: null,
        // verifier remains null → successRate treats this as failure (passed = undefined/false)
      } as BenchmarkTrial;
    }
    return t;
  });
  return buildAttritionLedger(modifiedTrials, "A0_baseline");
}
