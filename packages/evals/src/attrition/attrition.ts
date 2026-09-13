/**
 * ZB3 — Attrition classification.
 *
 * Classifies trials into included/excluded sets.
 * Missing pairs (trials present in one arm but not the matched arm) produce
 * explicit AttritionRecord entries — never silently filled with zeros.
 */

import type { BenchmarkTrial, BenchmarkTrialArm } from "@shokunin/benchmark-kit";
import type { AttritionRecord, AttritionReason, PairingKey } from "../../contracts/evals.contract.js";
import { ActionableEvalsError } from "../../contracts/errors.contract.js";

// ---------------------------------------------------------------------------
// Pairing key
// ---------------------------------------------------------------------------

/**
 * Canonical pairing key: campaignId|taskId|repetitionIndex|runtimeId|runtimeVersion|model
 * All fields are mandatory; any undefined → throw.
 */
export function buildPairingKey(trial: BenchmarkTrial): PairingKey {
  const { campaignId, task, execution, repetitionIndex } = trial;
  if (!campaignId || !task.id || !execution.runtimeId || !execution.runtimeVersion || !execution.model) {
    throw new ActionableEvalsError({
      code: "INPUT_INVALID",
      message: `Trial ${trial.trialId} is missing required pairing fields (campaignId, task.id, runtimeId, runtimeVersion, model).`,
      remediation: "Ensure all BenchmarkTrial records carry the mandatory provenance fields before calling the evals engine.",
      retryable: false,
      details: { trialId: trial.trialId },
    });
  }
  return JSON.stringify([
    campaignId,
    task.id,
    String(repetitionIndex),
    execution.runtimeId,
    execution.runtimeVersion,
    execution.model,
  ]) as PairingKey;
}

// ---------------------------------------------------------------------------
// Attrition reason derivation
// ---------------------------------------------------------------------------

/**
 * Derives the attrition reason for a trial that should be excluded.
 * Returns null if the trial should be INCLUDED in analysis.
 */
export function deriveAttritionReason(trial: BenchmarkTrial): AttritionReason | null {
  const fc = trial.failureClassification;
  if (fc === "EXOGENOUS_INFRASTRUCTURE_FAILURE") return "INFRASTRUCTURE_FAILURE";
  if (fc === "AGENT_RUNTIME_FAILURE") return "AGENT_RUNTIME_FAILURE";
  if (fc === "VERIFIER_FAILURE") return "VERIFIER_FAILURE";
  if (fc === "GOVERNANCE_FAILURE") return "GOVERNANCE_FAILURE";
  // Trial is technically complete but metrics are unqualified
  if (trial.verifier !== null && trial.metrics.falseCompletionTerminal === null) {
    // This is acceptable — falseCompletionTerminal may be null until qualified;
    // the trial can still be used for successRate analysis.
    return null;
  }
  return null; // include
}

// ---------------------------------------------------------------------------
// Attrition ledger builder
// ---------------------------------------------------------------------------

export interface AttritionLedger {
  /** Trials included per arm. */
  readonly included: ReadonlyMap<BenchmarkTrialArm, readonly BenchmarkTrial[]>;
  /** Attrition records for excluded trials. */
  readonly attrition: readonly AttritionRecord[];
}

/**
 * Build the attrition ledger for a set of trials.
 *
 * Policy:
 * 1. Trials with infrastructure/agent/verifier/governance failure → excluded with reason.
 * 2. Trials with no matching pair in the baseline (A0) arm → MISSING_PAIR for both.
 * 3. All other trials → included.
 *
 * The missing-pair detection only applies when the caller requests paired analysis
 * (baselineArm provided). When null, pairing is skipped.
 */
export function buildAttritionLedger(
  trials: readonly BenchmarkTrial[],
  baselineArm: BenchmarkTrialArm | null = "A0_baseline",
): AttritionLedger {
  const attrition: AttritionRecord[] = [];
  const includedByArm = new Map<BenchmarkTrialArm, BenchmarkTrial[]>();
  const seenPairingArms = new Set<string>();
  const observedTreatmentArms = new Set<BenchmarkTrialArm>();
  if (baselineArm !== null) {
    for (const trial of trials) {
      if (trial.arm !== baselineArm) observedTreatmentArms.add(trial.arm);
    }
  }

  // Phase 1: exclude trials with failure classifications
  const candidatesByPairingKey = new Map<PairingKey, Map<BenchmarkTrialArm, BenchmarkTrial>>();

  for (const trial of trials) {
    const key = buildPairingKey(trial);
    const uniquenessKey = `${trial.arm}\u0000${key}`;
    if (seenPairingArms.has(uniquenessKey)) {
      throw new ActionableEvalsError({
        code: "INPUT_INVALID",
        message: `Duplicate trial pairing key for arm ${trial.arm}: ${key}.`,
        remediation: "Provide at most one trial per campaign/task/repetition/runtime/model and arm.",
        retryable: false,
        details: { trialId: trial.trialId, arm: trial.arm, pairingKey: key },
      });
    }
    seenPairingArms.add(uniquenessKey);
    const reason = deriveAttritionReason(trial);
    if (reason !== null) {
      attrition.push({
        pairingKey: key,
        arm: trial.arm,
        reason,
        failureClassification: trial.failureClassification,
        trialId: trial.trialId,
      });
      continue;
    }

    if (!candidatesByPairingKey.has(key)) {
      candidatesByPairingKey.set(key, new Map());
    }
    const armMap = candidatesByPairingKey.get(key)!;
    // Duplicate trials cannot be silently discarded: that would bias ITT and
    // paired estimates while making the loss invisible in the attrition ledger.
    if (!armMap.has(trial.arm)) {
      armMap.set(trial.arm, trial);
    }
  }

  // Phase 2: if paired analysis requested, identify MISSING_PAIR entries
  if (baselineArm !== null) {
    for (const [key, armMap] of candidatesByPairingKey.entries()) {
      const hasBaseline = armMap.has(baselineArm);
      if (!hasBaseline) {
        // Record both sides: the observed treatment and the absent baseline.
        for (const [arm, trial] of armMap.entries()) {
          if (arm === baselineArm) continue;
          attrition.push({
            pairingKey: key,
            arm,
            reason: "MISSING_PAIR",
            failureClassification: null,
            trialId: trial.trialId,
          });
          armMap.delete(arm);
        }
        attrition.push({ pairingKey: key, arm: baselineArm, reason: "MISSING_PAIR", failureClassification: null, trialId: null });
      } else {
        // For a partial campaign, explicitly record every treatment arm that
        // exists elsewhere but is absent from this pairing key.
        const missingTreatmentArms = [...observedTreatmentArms].filter((arm) => !armMap.has(arm));
        for (const arm of missingTreatmentArms) {
          attrition.push({ pairingKey: key, arm, reason: "MISSING_PAIR", failureClassification: null, trialId: null });
        }
      }
      // A baseline can participate in a valid comparison for one treatment
      // while another treatment is absent.  Keep every observed arm here and
      // record absence per comparison; removing the baseline would incorrectly
      // discard the valid A0/A1 (or A0/A2) pair.
    }
  }

  // Phase 3: collect included trials by arm
  for (const armMap of candidatesByPairingKey.values()) {
    for (const [arm, trial] of armMap.entries()) {
      if (!includedByArm.has(arm)) includedByArm.set(arm, []);
      includedByArm.get(arm)!.push(trial);
    }
  }

  return {
    included: includedByArm as ReadonlyMap<BenchmarkTrialArm, readonly BenchmarkTrial[]>,
    attrition,
  };
}

// ---------------------------------------------------------------------------
// Extract matched pairs for bootstrap analysis
// ---------------------------------------------------------------------------

export interface MatchedPair {
  readonly key: PairingKey;
  readonly baseline: BenchmarkTrial;
  readonly treatment: BenchmarkTrial;
}

/**
 * Extract matched (baseline, treatment) pairs for a specific treatment arm.
 * Both trials must be in the included set (post-attrition).
 */
export function extractMatchedPairs(
  included: ReadonlyMap<BenchmarkTrialArm, readonly BenchmarkTrial[]>,
  baselineArm: BenchmarkTrialArm,
  treatmentArm: BenchmarkTrialArm,
): readonly MatchedPair[] {
  const baselineByKey = new Map<PairingKey, BenchmarkTrial>();
  for (const t of included.get(baselineArm) ?? []) {
    baselineByKey.set(buildPairingKey(t), t);
  }

  const pairs: MatchedPair[] = [];
  for (const t of included.get(treatmentArm) ?? []) {
    const key = buildPairingKey(t);
    const baseline = baselineByKey.get(key);
    if (baseline !== undefined) {
      pairs.push({ key, baseline, treatment: t });
    }
  }
  return pairs;
}
