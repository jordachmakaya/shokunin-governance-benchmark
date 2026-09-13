import test from "node:test";
import assert from "node:assert/strict";
import { assertPilotReady, evaluateTrials } from "../src/index.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("pilot readiness fails closed while prerequisites are pending", () => { assert.throws(() => assertPilotReady({ status: "PREREGISTERED", experimentId: "H1-completion-verification-001", hypothesisId: "H1_COMPLETION_GATE", campaignId: "H1-pilot-001", design: { tasks: 10, arms: 4, repetitionsPerTaskArm: 2, plannedTrials: 80 }, taskSelection: { manifestPath: "tasks.json", manifestSha256: null }, runtimeQualification: { status: "PENDING", a3Eligible: false }, runtime: { runtimeId: null, runtimeVersion: null, model: null } })); });
test("pilot readiness rejects forged minimal manifests", () => { assert.throws(() => assertPilotReady({ status: "PREREGISTERED" } as never)); });
test("pilot readiness rejects a task selection that is not frozen", () => {
  assert.throws(() => assertPilotReady({ status: "PREREGISTERED", experimentId: "H1-completion-verification-001", hypothesisId: "H1_COMPLETION_GATE", campaignId: "H1-pilot-001", benchmark: { datasetRef: "terminal-bench/terminal-bench-2-1", datasetPath: "dataset.json", datasetDigest: "a".repeat(64) }, design: { tasks: 10, arms: 4, repetitionsPerTaskArm: 2, plannedTrials: 80 }, taskSelection: { status: "PENDING_IMMUTABLE_FREEZE", manifestPath: "tasks.json", manifestSha256: "a".repeat(64), officialTaskIds: Array.from({ length: 10 }, (_, index) => `task-${index}`) }, runtimeQualification: { status: "PENDING", a3Eligible: false }, runtime: { runtimeId: null, runtimeVersion: null, model: null } }));
});
test("evaluation rejects inputs and outputs outside approved result roots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shokunin-cli-test-"));
  const input = join(dir, "trials.json");
  await writeFile(input, "[]", "utf8");
  await assert.rejects(() => evaluateTrials(input, input, { resamples: 1, seed: "test", confidenceLevel: 0.95, alternative: "two-sided" }));
  await rm(dir, { recursive: true, force: true });
});

test("evaluation rejects non-canonical and traversal result paths", async () => {
  await assert.rejects(() => evaluateTrials("benchmarks/execution-zone/raw-results/../normalized-results/in.json", "benchmarks/execution-zone/raw-results/out.json", { resamples: 10000, seed: "test", confidenceLevel: 0.95, alternative: "two-sided" }));
  await assert.rejects(() => evaluateTrials("./benchmarks/execution-zone/raw-results/in.json", "benchmarks/execution-zone/raw-results/out.json", { resamples: 10000, seed: "test", confidenceLevel: 0.95, alternative: "two-sided" }));
});
