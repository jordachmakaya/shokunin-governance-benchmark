/**
 * ZB3 — Hierarchical paired bootstrap BCa analysis.
 *
 * Implements §6.3 of the Master Plan:
 * - Clustered by task.id (unit of resampling)
 * - Pairs preserved within cluster
 * - Actual BCa: bias-correction z0 + jackknife acceleration a
 * - Minimum 10 000 resamples enforced
 * - Seed written into every result
 * - SHA-256 of input pairs stored for auditability
 */

import { createHash } from "node:crypto";
import type { BenchmarkTrial } from "@shokunin/benchmark-kit";
import type {
  BcaBootstrapConfig,
  PairedComparisonResult,
} from "../../contracts/evals.contract.js";
import type { MatchedPair } from "../attrition/attrition.js";
import {
  createSeededRng,
  bootstrapResampleIndices,
  computeBcaInterval,
} from "./prng.js";
import { ActionableEvalsError } from "../../contracts/errors.contract.js";

// ---------------------------------------------------------------------------
// Statistic: success rate delta (treatment - baseline)
// ---------------------------------------------------------------------------

function successRateDelta(pairs: readonly MatchedPair[]): number {
  if (pairs.length === 0) return 0;
  const baselineSuccess = pairs.filter((p) => p.baseline.verifier?.passed === true).length;
  const treatmentSuccess = pairs.filter((p) => p.treatment.verifier?.passed === true).length;
  return treatmentSuccess / pairs.length - baselineSuccess / pairs.length;
}

// ---------------------------------------------------------------------------
// Hierarchical cluster resample
// ---------------------------------------------------------------------------

/**
 * Groups matched pairs by task.id (cluster unit).
 */
function groupByTaskCluster(
  pairs: readonly MatchedPair[],
): Map<string, MatchedPair[]> {
  const clusters = new Map<string, MatchedPair[]>();
  for (const pair of pairs) {
    const taskId = pair.baseline.task.id;
    if (!clusters.has(taskId)) clusters.set(taskId, []);
    clusters.get(taskId)!.push(pair);
  }
  return clusters;
}

/**
 * Draw one hierarchical bootstrap resample:
 * 1. Resample task clusters (with replacement)
 * 2. Keep all pairs within each resampled cluster
 */
function hierarchicalResample(
  clusterKeys: string[],
  clusterMap: Map<string, MatchedPair[]>,
  rng: () => number,
): MatchedPair[] {
  const clusterIndices = bootstrapResampleIndices(clusterKeys.length, rng);
  const resampled: MatchedPair[] = [];
  for (const idx of clusterIndices) {
    const key = clusterKeys[idx]!;
    resampled.push(...(clusterMap.get(key) ?? []));
  }
  return resampled;
}

// ---------------------------------------------------------------------------
// Jackknife leave-one-cluster-out
// ---------------------------------------------------------------------------

function jackknifeDeltasByCluster(
  clusterKeys: string[],
  clusterMap: Map<string, MatchedPair[]>,
  allPairs: readonly MatchedPair[],
): number[] {
  const jackknifeMeans: number[] = [];
  for (let i = 0; i < clusterKeys.length; i++) {
    const excludedKey = clusterKeys[i]!;
    const leaveOneOut = allPairs.filter((p) => p.baseline.task.id !== excludedKey);
    jackknifeMeans.push(successRateDelta(leaveOneOut));
  }
  return jackknifeMeans;
}

// ---------------------------------------------------------------------------
// Main bootstrap analysis
// ---------------------------------------------------------------------------

export function computeBootstrapPairedDelta(
  pairs: readonly MatchedPair[],
  config: BcaBootstrapConfig,
): PairedComparisonResult {
  if (pairs.length === 0) {
    throw new ActionableEvalsError({
      code: "INSUFFICIENT_PAIRS",
      message: "Cannot run bootstrap analysis: no matched pairs available.",
      remediation: "Ensure at least one matched (baseline, treatment) trial pair exists after attrition.",
      retryable: false,
    });
  }

  // Stable input hash for auditability
  const inputHash = createHash("sha256")
    .update(JSON.stringify(pairs.map((p) => ({ baseline: p.baseline, treatment: p.treatment }))))
    .digest("hex");

  const observed = successRateDelta(pairs);
  const clusterMap = groupByTaskCluster(pairs);
  const clusterKeys = [...clusterMap.keys()].sort(); // deterministic ordering

  // Jackknife leave-one-cluster-out for acceleration
  const jackknifeMeans = jackknifeDeltasByCluster(clusterKeys, clusterMap, pairs);

  // Bootstrap resamples
  const rng = createSeededRng(config.seed);
  const bootstrapThetas: number[] = new Array(config.resamples);
  const nullThetas: number[] = new Array(config.resamples);
  for (let b = 0; b < config.resamples; b++) {
    const resample = hierarchicalResample(clusterKeys, clusterMap, rng);
    bootstrapThetas[b] = successRateDelta(resample);
    // Paired sign-flip null: under H0, each observed pair difference is
    // exchangeable between arms. Resampling clusters preserves dependence.
    const clusterSigns = new Map<string, number>();
    const nullPairs = resample.map((pair) => {
      const clusterKey = pair.baseline.task.id;
      if (!clusterSigns.has(clusterKey)) {
        clusterSigns.set(clusterKey, rng() < 0.5 ? 1 : -1);
      }
      const baseline = pair.baseline.verifier?.passed === true ? 1 : 0;
      const treatment = pair.treatment.verifier?.passed === true ? 1 : 0;
      const difference = treatment - baseline;
      return (clusterSigns.get(clusterKey) ?? 1) * difference;
    });
    nullThetas[b] = nullPairs.length === 0
      ? 0
      : nullPairs.reduce((sum, value) => sum + value, 0) / nullPairs.length;
  }

  const alpha = 1 - config.confidenceLevel;
  const bca = computeBcaInterval(observed, bootstrapThetas, jackknifeMeans, alpha, nullThetas);

  const taskClusterCount = new Set(pairs.map((p) => p.baseline.task.id)).size;

  return {
    deltaSuccessRate: observed,
    ciLow: bca.low,
    ciHigh: bca.high,
    sampleSizePairs: pairs.length,
    taskClusterCount,
    pValueTwoSided: bca.pValueTwoSided,
    z0: bca.z0,
    accelerationA: bca.accelerationA,
    seed: config.seed,
    inputHash,
  };
}
