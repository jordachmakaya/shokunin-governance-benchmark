/**
 * ZB3 — Tests: ZB3 evaluation engine.
 *
 * Coverage:
 * 1. Unit tests: prng, BCa interval, attrition, arm metrics
 * 2. Boundary/adversarial tests: empty input, missing pairs, null metrics, wrong campaign
 * 3. Substitutability tests: EvalsEngine satisfies IEvalsEngine against ZB2 frozen contracts
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { BenchmarkTrial } from "@shokunin/benchmark-kit";
import type { IEvalsEngine, BcaBootstrapConfig, AttritionRecord } from "../contracts/evals.contract.js";
import { ActionableEvalsError } from "../contracts/errors.contract.js";
import { EvalsEngine } from "../src/engine.js";
import { createSeededRng, normalCdf, normalQuantile, computeBcaInterval } from "../src/statistics/prng.js";
import { buildPairingKey, buildAttritionLedger, extractMatchedPairs } from "../src/attrition/attrition.js";
import { computeArmMetrics } from "../src/aggregation/arm-aggregation.js";
import { bcaBootstrapConfigSchema } from "../schemas/evals-report.schema.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_CONFIG: BcaBootstrapConfig = {
  resamples: 10000,
  seed: "zb3-test-seed-2026",
  confidenceLevel: 0.95,
  alternative: "two-sided",
};

const OCI = "sha256:" + "a".repeat(64);
const SHA = "b".repeat(64);

function makeTrial(overrides: Partial<BenchmarkTrial> & {
  arm: BenchmarkTrial["arm"];
  trialId: string;
  passed: boolean;
  taskId?: string;
  repetitionIndex?: number;
  fct?: boolean | null;
}): BenchmarkTrial {
  const taskId = overrides.taskId ?? "task-oracle-001";
  const repIdx = overrides.repetitionIndex ?? 0;
  return {
    experimentId: "exp-h1-test",
    hypothesisId: "H1_COMPLETION_GATE",
    campaignId: "campaign-test-001",
    repetitionIndex: repIdx,
    task: {
      id: taskId,
      benchmark: "terminal-bench",
      benchmarkVersion: "2.1.0",
      taskHash: SHA,
    },
    reproducibility: {
      configHash: SHA,
      promptHash: SHA,
      containerDigest: OCI,
    },
    provenance: {
      prompt: { kind: "prompt-bytes", originPath: "/prompt.md", byteLength: 42, sha256: SHA },
      container: { kind: "container-manifest", originPath: "/manifest", byteLength: 100, sha256: SHA },
      workspaceSnapshot: { kind: "workspace-snapshot", originPath: "/ws", byteLength: 200, sha256: SHA },
    },
    harbor: {
      jobId: "00000000-0000-0000-0000-000000000000",
      trialId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      trialName: `trial-${overrides.trialId}`,
      resultPath: `/jobs/job-001/${overrides.trialId}/result.json`,
      resultHash: SHA,
      containerId: "container-001",
      containerDigest: OCI,
    },
    distribution: "wheel-verified",
    execution: {
      runtimeId: "harbor-cli",
      runtimeVersion: "0.1.2",
      model: "claude-opus-4",
      modelTemperature: null,
      runtimeRunId: overrides.trialId,
      workspaceId: `ws-${overrides.trialId}`,
      claims: [],
      finalStopReason: overrides.passed ? "agent_declared_done" : "gate_blocked_exhausted",
      totalRecoveryCount: 0,
    },
    verifier: overrides.passed
      ? {
          authority: "harbor-task-verifier",
          passed: true,
          reward: 1.0,
          durationMs: 100,
          verifierOutputHash: SHA,
        }
      : null,
    failureClassification: overrides.passed ? null : (overrides.failureClassification ?? "GOVERNANCE_FAILURE"),
    metrics: {
      falseCompletionInitial: null,
      falseCompletionTerminal:
        overrides.fct !== undefined
          ? overrides.fct
          : (overrides.passed ? false : null),
      falseCompletionIntercepted: null,
      recoverySuccessful: null,
    },
    usage: {
      inputTokens: 500,
      outputTokens: 200,
      costUsd: 0.01,
      durationMs: 5000,
    },
    // Explicit last — trialId and arm override any inferred values
    trialId: overrides.trialId,
    arm: overrides.arm,
  } as unknown as BenchmarkTrial;
}


// ---------------------------------------------------------------------------
// 1. PRNG tests
// ---------------------------------------------------------------------------

test("prng: createSeededRng produces values in [0, 1)", () => {
  const rng = createSeededRng("test-seed");
  for (let i = 0; i < 1000; i++) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `Value ${v} out of range`);
  }
});

test("prng: same seed produces identical sequence", () => {
  const rng1 = createSeededRng("abc");
  const rng2 = createSeededRng("abc");
  for (let i = 0; i < 100; i++) {
    assert.equal(rng1(), rng2());
  }
});

test("prng: different seeds produce different sequences", () => {
  const rng1 = createSeededRng("seed-A");
  const rng2 = createSeededRng("seed-B");
  let diffCount = 0;
  for (let i = 0; i < 100; i++) {
    if (rng1() !== rng2()) diffCount++;
  }
  assert.ok(diffCount > 80, "Seeds should produce meaningfully different sequences");
});

// ---------------------------------------------------------------------------
// 2. Normal quantile/CDF tests
// ---------------------------------------------------------------------------

test("normalQuantile: standard quantiles", () => {
  // z = -1.96 for p = 0.025
  const z = normalQuantile(0.025);
  assert.ok(Math.abs(z - (-1.96)) < 0.01, `Expected ~-1.96, got ${z}`);
});

test("normalQuantile: z=0 for p=0.5", () => {
  const z = normalQuantile(0.5);
  assert.ok(Math.abs(z) < 0.001, `Expected ~0, got ${z}`);
});

test("normalCdf: CDF(0) ≈ 0.5", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 0.001);
});

test("normalCdf: CDF(-1.96) ≈ 0.025", () => {
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 0.002);
});

test("normalQuantile: throws for p=0 and p=1", () => {
  assert.throws(() => normalQuantile(0), RangeError);
  assert.throws(() => normalQuantile(1), RangeError);
});

// ---------------------------------------------------------------------------
// 3. BCa interval: boundary / adversarial
// ---------------------------------------------------------------------------

test("computeBcaInterval: symmetric around zero gives CI containing zero", () => {
  // All bootstrap thetas are zero → observed is zero → CI should be [0,0]
  const thetas = new Array(10000).fill(0);
  const jackknife = new Array(5).fill(0);
  const bca = computeBcaInterval(0, thetas, jackknife, 0.05);
  assert.equal(bca.low, 0);
  assert.equal(bca.high, 0);
});

test("computeBcaInterval: all positive thetas → p-value large for observed=0", () => {
  const rng = createSeededRng("bca-test");
  const thetas = Array.from({ length: 10000 }, () => 0.1 + rng() * 0.1);
  const jackknife = new Array(10).fill(0.15);
  const bca = computeBcaInterval(0, thetas, jackknife, 0.05);
  // All bootstrap values > 0, observed = 0 → p-value should be 1 (none are extreme)
  assert.ok(bca.pValueTwoSided > 0.5, `Expected high p-value for non-extreme observed, got ${bca.pValueTwoSided}`);
});

test("computeBcaInterval: rejects empty inputs and invalid alpha", () => {
  assert.throws(() => computeBcaInterval(0, [], [0], 0.05), /bootstrapThetas must not be empty/);
  assert.throws(() => computeBcaInterval(0, [0], [], 0.05), /jackknifeMeans must not be empty/);
  assert.throws(() => computeBcaInterval(0, [0], [0], 0), /alpha must be finite and in \(0,1\)/);
  assert.throws(() => computeBcaInterval(0, [0], [0], Number.NaN), /alpha must be finite and in \(0,1\)/);
});

test("computeBcaInterval: rejects non-finite statistic values", () => {
  assert.throws(() => computeBcaInterval(0, [Number.NaN], [0], 0.05), /all statistic values must be finite/);
  assert.throws(() => computeBcaInterval(0, [0], [Number.POSITIVE_INFINITY], 0.05), /all statistic values must be finite/);
});

// ---------------------------------------------------------------------------
// 4. Attrition: pairing key
// ---------------------------------------------------------------------------

test("buildPairingKey: canonical format", () => {
  const t = makeTrial({ arm: "A0_baseline", trialId: "t1", passed: true });
  const key = buildPairingKey(t);
  assert.ok(key.includes("campaign-test-001"));
  assert.ok(key.includes("task-oracle-001"));
  assert.ok(key.includes("harbor-cli"));
  assert.ok(key.includes("claude-opus-4"));
});

test("buildPairingKey: different repetitionIndex → different keys", () => {
  const t1 = makeTrial({ arm: "A0_baseline", trialId: "t1", passed: true, repetitionIndex: 0 });
  const t2 = makeTrial({ arm: "A0_baseline", trialId: "t2", passed: true, repetitionIndex: 1 });
  assert.notEqual(buildPairingKey(t1), buildPairingKey(t2));
});

// ---------------------------------------------------------------------------
// 5. Attrition ledger: infrastructure failure exclusion
// ---------------------------------------------------------------------------

test("buildAttritionLedger: infra failure trial is excluded with reason", () => {
  const baseline = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const infraFail = {
    ...makeTrial({ arm: "A0_baseline", trialId: "b2", passed: false, repetitionIndex: 1 }),
    failureClassification: "EXOGENOUS_INFRASTRUCTURE_FAILURE" as const,
  } as BenchmarkTrial;

  const { attrition, included } = buildAttritionLedger([baseline, infraFail], null);
  assert.equal(attrition.length, 1);
  assert.equal(attrition[0]!.reason, "INFRASTRUCTURE_FAILURE");
  assert.equal(included.get("A0_baseline")?.length, 1);
});

// ---------------------------------------------------------------------------
// 6. Attrition ledger: missing pair detection
// ---------------------------------------------------------------------------

test("buildAttritionLedger: treatment without baseline → MISSING_PAIR", () => {
  // No baseline (A0) trial for this pairing key
  const treatment = makeTrial({ arm: "A2_blocking", trialId: "tx1", passed: true });
  const { attrition } = buildAttritionLedger([treatment], "A0_baseline");
  const missingPair = attrition.find((a) => a.reason === "MISSING_PAIR");
  assert.ok(missingPair, "Should have MISSING_PAIR attrition record");
  assert.equal(missingPair.arm, "A2_blocking");
});

test("buildAttritionLedger: matched pairs are NOT attritioned", () => {
  const baseline = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const treatment = makeTrial({ arm: "A2_blocking", trialId: "t1", passed: true });
  const { attrition, included } = buildAttritionLedger([baseline, treatment], "A0_baseline");
  assert.equal(attrition.length, 0);
  assert.equal(included.get("A0_baseline")?.length, 1);
  assert.equal(included.get("A2_blocking")?.length, 1);
});

test("buildAttritionLedger: partial campaign records the absent arm explicitly", () => {
  const baseline = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const treatmentOtherKey = makeTrial({ arm: "A2_blocking", trialId: "t2", passed: true, taskId: "other-task" });
  const { attrition, included } = buildAttritionLedger([baseline, treatmentOtherKey], "A0_baseline");
  const missingTreatment = attrition.find((record) => record.reason === "MISSING_PAIR" && record.arm === "A2_blocking");
  assert.ok(missingTreatment, "missing treatment arm must be recorded");
  assert.equal(missingTreatment.trialId, null);
  assert.equal(included.get("A0_baseline")?.length ?? 0, 1);
});

test("buildAttritionLedger: preserves valid A0/A1 while recording missing A2", () => {
  const baseline = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const observing = makeTrial({ arm: "A1_observing", trialId: "o1", passed: true });
  const blockingOtherKey = makeTrial({ arm: "A2_blocking", trialId: "k2", passed: true, taskId: "other-task" });
  const { attrition, included } = buildAttritionLedger([baseline, observing, blockingOtherKey], "A0_baseline");
  assert.equal(attrition.filter((record) => record.pairingKey === buildPairingKey(baseline)).length, 1);
  assert.equal(attrition.find((record) => record.pairingKey === buildPairingKey(baseline))?.arm, "A2_blocking");
  assert.equal(included.get("A0_baseline")?.length ?? 0, 1);
  assert.equal(included.get("A1_observing")?.length ?? 0, 1);
  assert.equal(extractMatchedPairs(included, "A0_baseline", "A1_observing").length, 1);
});

// ---------------------------------------------------------------------------
// 7. Arm metrics: success rate accuracy
// ---------------------------------------------------------------------------

test("computeArmMetrics: correct success rate", () => {
  const t1 = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const t2 = makeTrial({ arm: "A0_baseline", trialId: "b2", passed: false, repetitionIndex: 1,
    failureClassification: "GOVERNANCE_FAILURE" as const });
  // Only t1 passes (t2 is excluded due to failure classification)
  const { included, attrition } = buildAttritionLedger([t1, t2], null);
  const metrics = computeArmMetrics(included, attrition, [t1, t2]);
  const a0 = metrics.find((m) => m.arm === "A0_baseline");
  assert.ok(a0);
  assert.equal(a0.trialsIncluded, 1);
  assert.equal(a0.successRate, 1.0);
});

test("computeArmMetrics: 0% success rate when all fail", () => {
  const t1 = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: false,
    failureClassification: null });
  // Override verifier to null to make it count as failure
  const trial: BenchmarkTrial = { ...t1, verifier: null, failureClassification: "GOVERNANCE_FAILURE" };
  // Actually we need a trial that is included but with passed=false verifier
  const passedFalseTrial = makeTrial({ arm: "A0_baseline", trialId: "pf1", passed: true });
  // Override verifier.passed to false
  const failingTrial: BenchmarkTrial = {
    ...passedFalseTrial,
    verifier: {
      authority: "harbor-task-verifier",
      passed: false,
      reward: 0,
      durationMs: 100,
      verifierOutputHash: SHA,
    },
    failureClassification: null,
  };
  const { included, attrition } = buildAttritionLedger([failingTrial], null);
  const metrics = computeArmMetrics(included, attrition, [failingTrial]);
  const a0 = metrics.find((m) => m.arm === "A0_baseline");
  assert.ok(a0);
  assert.equal(a0.successRate, 0);
});

test("computeArmMetrics: null falseCompletionTerminalRate when all null", () => {
  const t = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true, fct: null });
  const { included, attrition } = buildAttritionLedger([t], null);
  const metrics = computeArmMetrics(included, attrition, [t]);
  const a0 = metrics.find((m) => m.arm === "A0_baseline");
  assert.equal(a0?.falseCompletionTerminalRate, null);
});

test("computeArmMetrics: recovery rate retains exhausted A3 governance attrition", () => {
  const recoveredBase = makeTrial({
    arm: "A3_recovering",
    trialId: "a3-recovered",
    passed: true,
  });
  const recovered: BenchmarkTrial = {
    ...recoveredBase,
    execution: { ...recoveredBase.execution, totalRecoveryCount: 1 },
    metrics: { ...recoveredBase.metrics, recoverySuccessful: true },
  };
  const exhaustedBase = makeTrial({
    arm: "A3_recovering",
    trialId: "a3-exhausted",
    passed: false,
    failureClassification: "GOVERNANCE_FAILURE",
  });
  const exhausted: BenchmarkTrial = {
    ...exhaustedBase,
    execution: { ...exhaustedBase.execution, totalRecoveryCount: 3 },
    metrics: { ...exhaustedBase.metrics, recoverySuccessful: false },
  };

  const allTrials = [recovered, exhausted];
  const included = new Map<BenchmarkTrial["arm"], readonly BenchmarkTrial[]>([
    ["A3_recovering", [recovered]],
  ]);
  const attrition: readonly AttritionRecord[] = [{
    pairingKey: "a3-exhausted-pair" as AttritionRecord["pairingKey"],
    arm: "A3_recovering",
    reason: "GOVERNANCE_FAILURE",
    failureClassification: "GOVERNANCE_FAILURE",
    trialId: exhausted.trialId,
  }];
  const a3 = computeArmMetrics(included, attrition, allTrials).find(
    (metrics) => metrics.arm === "A3_recovering",
  );

  assert.equal(a3?.trialsIncluded, 1, "exhausted gate remains primary-analysis attrition");
  assert.equal(a3?.trialsExcluded, 1);
  assert.equal(a3?.recoverySuccessRate, 0.5, "failed recovery must remain in the recovery denominator");
});

// ---------------------------------------------------------------------------
// 8. Bootstrap: paired delta with known outcome
// ---------------------------------------------------------------------------

test("bootstrapPairedDelta: 100% treatment vs 0% baseline → positive delta", async () => {
  // Create 10 task clusters, each with one (baseline=fail, treatment=pass) pair
  const trials: BenchmarkTrial[] = [];
  for (let i = 0; i < 10; i++) {
    trials.push(makeTrial({ arm: "A0_baseline", trialId: `b${i}`, passed: false,
      taskId: `task-${i}`, failureClassification: null }));
    trials.push(makeTrial({ arm: "A2_blocking", trialId: `t${i}`, passed: true,
      taskId: `task-${i}` }));
  }
  // Fix: baseline trials must have verifier.passed=false but not failureClassification
  const fixedTrials = trials.map((t): BenchmarkTrial => {
    if (t.arm === "A0_baseline") {
      return {
        ...t,
        verifier: {
          authority: "harbor-task-verifier",
          passed: false,
          reward: 0,
          durationMs: 100,
          verifierOutputHash: SHA,
        },
        failureClassification: null,
      };
    }
    return t;
  });

  const engine = new EvalsEngine();
  const config: BcaBootstrapConfig = { ...VALID_CONFIG, resamples: 10000 };
  const report = await engine.computeReport(fixedTrials, config);
  const comparison = report.pairedComparisons.get("A2_blocking_vs_A0_baseline");
  assert.ok(comparison, "Should have A2 vs A0 comparison");
  assert.ok(comparison.deltaSuccessRate > 0.5, `Expected positive delta, got ${comparison.deltaSuccessRate}`);
  assert.ok(comparison.ciLow > 0, `Expected CI lower bound > 0, got ${comparison.ciLow}`);
  assert.equal(comparison.seed, VALID_CONFIG.seed);
  assert.ok(comparison.inputHash.length === 64, "inputHash should be 64 hex chars");
});

test("bootstrapPairedDelta: null delta when baseline = treatment", async () => {
  const trials: BenchmarkTrial[] = [];
  for (let i = 0; i < 5; i++) {
    trials.push(makeTrial({ arm: "A0_baseline", trialId: `b${i}`, passed: true, taskId: `task-${i}` }));
    trials.push(makeTrial({ arm: "A2_blocking", trialId: `t${i}`, passed: true, taskId: `task-${i}` }));
  }
  const engine = new EvalsEngine();
  const report = await engine.computeReport(trials, VALID_CONFIG);
  const comparison = report.pairedComparisons.get("A2_blocking_vs_A0_baseline");
  assert.ok(comparison);
  assert.ok(Math.abs(comparison.deltaSuccessRate) < 0.01, `Expected ~0 delta, got ${comparison.deltaSuccessRate}`);
});

// ---------------------------------------------------------------------------
// 9. Adversarial / boundary
// ---------------------------------------------------------------------------

test("EvalsEngine: throws INPUT_INVALID for empty trials", async () => {
  const engine = new EvalsEngine();
  await assert.rejects(
    () => engine.computeReport([], VALID_CONFIG),
    (err: unknown) => {
      assert.ok(err instanceof ActionableEvalsError);
      assert.equal((err as ActionableEvalsError).code, "INPUT_INVALID");
      return true;
    },
  );
});

test("EvalsEngine: throws CONFIG_INVALID for resamples < 10000", async () => {
  const engine = new EvalsEngine();
  const t = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  await assert.rejects(
    () => engine.computeReport([t], { ...VALID_CONFIG, resamples: 999 }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableEvalsError);
      assert.equal((err as ActionableEvalsError).code, "CONFIG_INVALID");
      return true;
    },
  );
});

test("EvalsEngine: throws INPUT_INVALID for mixed experimentIds", async () => {
  const engine = new EvalsEngine();
  const t1 = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const t2: BenchmarkTrial = { ...makeTrial({ arm: "A0_baseline", trialId: "b2", passed: false,
    failureClassification: "GOVERNANCE_FAILURE" as const }), experimentId: "exp-OTHER" };
  await assert.rejects(
    () => engine.computeReport([t1, t2], VALID_CONFIG),
    (err: unknown) => {
      assert.ok(err instanceof ActionableEvalsError);
      assert.equal((err as ActionableEvalsError).code, "INPUT_INVALID");
      return true;
    },
  );
});

test("EvalsEngine: throws INPUT_INVALID for mixed campaignIds", async () => {
  const engine = new EvalsEngine();
  const first = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const second = {
    ...makeTrial({ arm: "A0_baseline", trialId: "b2", passed: true }),
    campaignId: "campaign-other",
  } as BenchmarkTrial;
  await assert.rejects(
    () => engine.computeReport([first, second], VALID_CONFIG),
    (err: unknown) => {
      assert.ok(err instanceof ActionableEvalsError);
      assert.equal((err as ActionableEvalsError).code, "INPUT_INVALID");
      return true;
    },
  );
});

test("EvalsEngine: single trial no paired comparison produced", async () => {
  const engine = new EvalsEngine();
  const t = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const report = await engine.computeReport([t], VALID_CONFIG);
  // No treatment arm → no paired comparisons
  assert.equal(report.pairedComparisons.size, 0);
  assert.equal(report.armMetrics.length, 1);
});

test("EvalsEngine: attrition ledger includes MISSING_PAIR for unmatched treatment", async () => {
  const engine = new EvalsEngine();
  // Only treatment arm, no baseline
  const t = makeTrial({ arm: "A2_blocking", trialId: "tx1", passed: true });
  const attrition = engine.computeAttrition([t]);
  assert.ok(attrition.some((a) => a.reason === "MISSING_PAIR"));
});

test("EvalsEngine: no paired comparison when insufficient pairs after attrition", async () => {
  const engine = new EvalsEngine();
  // Treatment trial only (no baseline partner) → MISSING_PAIR → no comparison
  const t = makeTrial({ arm: "A2_blocking", trialId: "tx1", passed: true });
  const report = await engine.computeReport([t], VALID_CONFIG);
  assert.equal(report.pairedComparisons.size, 0);
});

// ---------------------------------------------------------------------------
// 10. Substitutability test: EvalsEngine satisfies IEvalsEngine
// ---------------------------------------------------------------------------

test("substitutability: EvalsEngine implements IEvalsEngine", () => {
  // TypeScript structural check at compile time. At runtime we verify the shape.
  const engine: IEvalsEngine = new EvalsEngine();
  assert.equal(typeof engine.computeReport, "function");
  assert.equal(typeof engine.computeArmMetrics, "function");
  assert.equal(typeof engine.computeAttrition, "function");
});

test("substitutability: engine returns frozen ZB2 BenchmarkTrial-compatible shape in report", async () => {
  const engine = new EvalsEngine();
  const t = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const report = await engine.computeReport([t], VALID_CONFIG);
  // Verify report shape against schema
  const { evalReportSchema } = await import("../schemas/evals-report.schema.js");
  // Convert Map to array for schema validation
  const serializable = {
    ...report,
    pairedComparisons: [...report.pairedComparisons.entries()],
    intentionToTreat: report.intentionToTreat.map((itt) => ({
      ...itt,
      attritionByReason: [...(itt.attritionByReason as Map<string, number>).entries()],
    })),
    sensitivityAnalysis: [...report.sensitivityAnalysis.entries()],
  };
  const result = evalReportSchema.safeParse(serializable);
  if (!result.success) {
    assert.fail(`EvalReport schema validation failed: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
});

// ---------------------------------------------------------------------------
// 11. Causal order preservation test
// ---------------------------------------------------------------------------

test("arm metrics: ordering follows A0 → A1 → A2 → A3", async () => {
  const engine = new EvalsEngine();
  const trials = [
    makeTrial({ arm: "A3_recovering", trialId: "t3", passed: true, taskId: "tk1" }),
    makeTrial({ arm: "A1_observing", trialId: "t1", passed: true, taskId: "tk1" }),
    makeTrial({ arm: "A0_baseline", trialId: "t0", passed: true, taskId: "tk1" }),
    makeTrial({ arm: "A2_blocking", trialId: "t2", passed: true, taskId: "tk1" }),
  ];
  const report = await engine.computeReport(trials, VALID_CONFIG);
  const armOrder = report.armMetrics.map((m) => m.arm);
  // Should always appear in A0→A1→A2→A3 order
  const a0idx = armOrder.indexOf("A0_baseline");
  const a1idx = armOrder.indexOf("A1_observing");
  const a2idx = armOrder.indexOf("A2_blocking");
  const a3idx = armOrder.indexOf("A3_recovering");
  assert.ok(a0idx < a1idx && a1idx < a2idx && a2idx < a3idx,
    `Expected A0<A1<A2<A3, got indices: ${[a0idx, a1idx, a2idx, a3idx]}`);
});

// ---------------------------------------------------------------------------
// 12. ITT: infrastructure failures treated as failures (not excluded)
// ---------------------------------------------------------------------------

test("ITT: infra failure counts as failure in ITT success rate", async () => {
  const engine = new EvalsEngine();
  const passing = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const infraFail: BenchmarkTrial = {
    ...makeTrial({ arm: "A0_baseline", trialId: "b2", passed: false, repetitionIndex: 1 }),
    failureClassification: "EXOGENOUS_INFRASTRUCTURE_FAILURE",
    verifier: null,
  };
  const report = await engine.computeReport([passing, infraFail], VALID_CONFIG);
  const a0itt = report.intentionToTreat.find((i) => i.arm === "A0_baseline");
  assert.ok(a0itt);
  assert.equal(a0itt.totalTrialsAssigned, 2);
  assert.equal(a0itt.successRate, 0.5); // 1 out of 2 passes in ITT
});

// ---------------------------------------------------------------------------
// 13. Missing value preservation — null is never coerced to 0
// ---------------------------------------------------------------------------

test("arm metrics: null usage fields do not affect non-null means", () => {
  const withTokens = makeTrial({ arm: "A0_baseline", trialId: "b1", passed: true });
  const withNullTokens: BenchmarkTrial = {
    ...makeTrial({ arm: "A0_baseline", trialId: "b2", passed: true, repetitionIndex: 1 }),
    usage: { inputTokens: null, outputTokens: null, costUsd: null, durationMs: 3000 },
  };
  const { included, attrition } = buildAttritionLedger([withTokens, withNullTokens], null);
  const metrics = computeArmMetrics(included, attrition, [withTokens, withNullTokens]);
  const a0 = metrics.find((m) => m.arm === "A0_baseline");
  // Mean should only include the non-null values (n=1), not treat null as 0
  assert.ok(a0);
  assert.equal(a0.meanInputTokens, 500); // Only one non-null value
});

// ---------------------------------------------------------------------------
// 14. BCa config schema validation
// ---------------------------------------------------------------------------

test("bcaBootstrapConfigSchema: rejects resamples < 10000", () => {
  const result = bcaBootstrapConfigSchema.safeParse({ ...VALID_CONFIG, resamples: 5000 });
  assert.equal(result.success, false);
});

test("bcaBootstrapConfigSchema: rejects confidenceLevel >= 1", () => {
  const result = bcaBootstrapConfigSchema.safeParse({ ...VALID_CONFIG, confidenceLevel: 1.0 });
  assert.equal(result.success, false);
});

test("bcaBootstrapConfigSchema: rejects one-sided alternative", () => {
  const result = bcaBootstrapConfigSchema.safeParse({ ...VALID_CONFIG, alternative: "one-sided" });
  assert.equal(result.success, false);
});

test("bcaBootstrapConfigSchema: accepts valid config", () => {
  const result = bcaBootstrapConfigSchema.safeParse(VALID_CONFIG);
  assert.equal(result.success, true);
});
