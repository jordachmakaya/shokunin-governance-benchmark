/**
 * ZB3 — Evaluation & Statistics Engine public contracts.
 *
 * Consumed by: ZB6 (CLI), ZB7 (Publication), ZB8 (MCP).
 * Depends on: frozen BenchmarkTrial contract from ZB2.
 *
 * CONTRACT MIGRATION NOTICE:
 * Any change to this file requires a formal migration receipt in MEMORY.md
 * and explicit Integration Owner approval.
 */

import type { BenchmarkTrial, BenchmarkTrialArm, TrialFailureClassification } from "@shokunin/benchmark-kit";

// ---------------------------------------------------------------------------
// 1. Pairing & Attrition
// ---------------------------------------------------------------------------

/**
 * Canonical pairing key for matched-pair bootstrap analysis.
 * Fields: campaignId | task.id | repetitionIndex | runtimeId | runtimeVersion | model
 * All fields are mandatory; no interpolation permitted.
 */
export type PairingKey = string & { readonly __brand: "PairingKey" };

export type AttritionReason =
  | "MISSING_PAIR"              // One arm has no trial for this pairing key
  | "INFRASTRUCTURE_FAILURE"    // Trial classified as exogenous infrastructure failure
  | "AGENT_RUNTIME_FAILURE"     // Trial classified as agent runtime failure
  | "VERIFIER_FAILURE"          // Trial classified as verifier failure
  | "GOVERNANCE_FAILURE"        // Trial classified as governance (gate) failure
  | "INCOMPLETE_METRICS";       // Required metric is null (not yet qualified)

export interface AttritionRecord {
  readonly pairingKey: PairingKey;
  readonly arm: BenchmarkTrialArm;
  readonly reason: AttritionReason;
  readonly failureClassification: TrialFailureClassification | null;
  /** Original trialId if the trial exists but is excluded; null for MISSING_PAIR. */
  readonly trialId: string | null;
}

// ---------------------------------------------------------------------------
// 2. Per-arm aggregated metrics (primary analysis)
// ---------------------------------------------------------------------------

export interface ArmSuccessMetrics {
  readonly arm: BenchmarkTrialArm;
  /** Number of trials that entered analysis (after attrition removal). */
  readonly trialsIncluded: number;
  /** Number of trials excluded (any attrition reason). */
  readonly trialsExcluded: number;
  /** Proportion of included trials where verifier.passed === true. */
  readonly successRate: number;
  /** Proportion of included trials where falseCompletionTerminal === true.
   *  null if all trials in this arm have null falseCompletionTerminal. */
  readonly falseCompletionTerminalRate: number | null;
  /** Mean input tokens across included trials with non-null usage. */
  readonly meanInputTokens: number | null;
  /** Mean output tokens across included trials with non-null usage. */
  readonly meanOutputTokens: number | null;
  /** Mean costUsd across included trials with non-null usage. */
  readonly meanCostUsd: number | null;
  /** Median durationMs across all included trials. */
  readonly medianDurationMs: number;
  /** Gate detection rate for A1 arm: fraction of claims where gateVerdict === 'BLOCK'.
   *  null for arms other than A1_observing. */
  readonly gateDetectionRate: number | null;
  /** Recovery success rate for A3 arm: fraction where recoverySuccessful === true.
   *  null for arms other than A3_recovering. */
  readonly recoverySuccessRate: number | null;
  /** Fraction of trials intercepted (gateVerdict BLOCK) for A2/A3. null for A0/A1. */
  readonly falseCompletionInterceptedRate: number | null;
}

// ---------------------------------------------------------------------------
// 3. Bootstrap BCa paired comparison
// ---------------------------------------------------------------------------

export interface BcaBootstrapConfig {
  /**
   * Number of bootstrap resamples. Minimum 10 000 enforced.
   */
  readonly resamples: number;
  /**
   * Seed string for the PRNG. Written into every report for reproducibility.
   */
  readonly seed: string;
  /**
   * Confidence level for BCa interval (typically 0.95).
   */
  readonly confidenceLevel: number;
  /**
   * Always two-sided per master plan §6.3.
   */
  readonly alternative: "two-sided";
}

export interface PairedComparisonResult {
  /** Delta = treatment successRate − baseline successRate. */
  readonly deltaSuccessRate: number;
  /** BCa 95% CI lower bound. */
  readonly ciLow: number;
  /** BCa 95% CI upper bound. */
  readonly ciHigh: number;
  /** Number of matched pairs entering this comparison. */
  readonly sampleSizePairs: number;
  /** Number of distinct task clusters (task.id values) in the analysis. */
  readonly taskClusterCount: number;
  /** Two-sided bootstrap p-value (not asymptotic). */
  readonly pValueTwoSided: number;
  /** Bias-correction constant z0 (BCa). */
  readonly z0: number;
  /** Jackknife acceleration constant a (BCa). */
  readonly accelerationA: number;
  /** Seed used for this computation. */
  readonly seed: string;
  /** SHA-256 hex of the serialized input pairs (for auditability). */
  readonly inputHash: string;
}

// ---------------------------------------------------------------------------
// 4. Intention-to-treat analysis
// ---------------------------------------------------------------------------

export interface IntentionToTreatResult {
  /**
   * All original trials, including those excluded from primary analysis.
   * Infrastructure failures count as failures (not excluded).
   */
  readonly arm: BenchmarkTrialArm;
  readonly totalTrialsAssigned: number;
  readonly successRate: number;
  readonly attritionRate: number;
  readonly attritionByReason: ReadonlyMap<AttritionReason, number>;
}

// ---------------------------------------------------------------------------
// 5. Sensitivity analysis
// ---------------------------------------------------------------------------

export interface SensitivityAnalysisResult {
  /**
   * Paired comparison result EXCLUDING infrastructure failures from baseline.
   */
  readonly excludingInfraFailures: PairedComparisonResult;
  /**
   * Paired comparison result INCLUDING infrastructure failures (as failures).
   */
  readonly includingInfraFailures: PairedComparisonResult;
}

// ---------------------------------------------------------------------------
// 6. Full evaluation report
// ---------------------------------------------------------------------------

export interface EvalReport {
  readonly schemaVersion: "1.0.0";
  readonly experimentId: string;
  readonly hypothesisId: string;
  readonly campaignId: string;
  readonly generatedAt: string;
  readonly trialsInput: number;
  readonly bootstrapConfig: BcaBootstrapConfig;
  /** Ordered A0→A1→A2→A3. Missing arms produce no entry. */
  readonly armMetrics: readonly ArmSuccessMetrics[];
  /** Attrition ledger — all excluded trials with reason. */
  readonly attrition: readonly AttritionRecord[];
  /** Primary analysis: each treatment arm vs A0_baseline. */
  readonly pairedComparisons: ReadonlyMap<string, PairedComparisonResult>;
  /** Intention-to-treat analysis per arm. */
  readonly intentionToTreat: readonly IntentionToTreatResult[];
  /** Sensitivity analysis (one entry per treatment comparison). */
  readonly sensitivityAnalysis: ReadonlyMap<string, SensitivityAnalysisResult>;
}

// ---------------------------------------------------------------------------
// 7. Engine interface (substitutability contract)
// ---------------------------------------------------------------------------

export interface IEvalsEngine {
  /**
   * Compute a full EvalReport from raw BenchmarkTrial records.
   * Trials must all share the same experimentId, hypothesisId, and campaignId.
   * Throws ActionableEvalsError if invariants are violated.
   */
  computeReport(
    trials: readonly BenchmarkTrial[],
    config: BcaBootstrapConfig,
  ): Promise<EvalReport>;

  /**
   * Compute only the per-arm aggregate metrics (no bootstrap, fast path).
   */
  computeArmMetrics(
    trials: readonly BenchmarkTrial[],
  ): readonly ArmSuccessMetrics[];

  /**
   * Compute the attrition ledger without running bootstrap.
   */
  computeAttrition(
    trials: readonly BenchmarkTrial[],
  ): readonly AttritionRecord[];
}
