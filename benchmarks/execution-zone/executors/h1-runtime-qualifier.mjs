#!/usr/bin/env node
/** Real, non-pilot probe for Codex A3 resume/feedback/runtime capabilities. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_ALLOWLIST, HarborBridgeSession, OFFICIAL_HARBOR_WHEEL_SHA256,
  computeTaskChecksum, executeVerticalSlice,
} from "../../../packages/benchmark-kit/dist/src/index.js";
import { evaluateCheck, readPublicTaskConfig } from "./h1-executor.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OUTPUT_ROOT = resolve(REPO_ROOT, "benchmarks/execution-zone/raw-results/qualification");
const WHEEL_PATH = resolve(REPO_ROOT, "packages/benchmark-kit/tests/fixtures/harbor/vendor/harbor-0.1.2-py3-none-any.whl");
const LOCK_PATH = resolve(REPO_ROOT, "packages/benchmark-kit/tests/fixtures/harbor/requirements.lock");
const BRIDGE_PATH = resolve(REPO_ROOT, "packages/benchmark-kit/bridge/shokunin_intercept_agent.py");
const MARKER = "app/shokunin-runtime-resume-proof.txt";
const MARKER_CONTENT = "SHOKUNIN_RUNTIME_RESUME_VERIFIED\n";
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function loadCredentials() {
  const path = "/home/jordach/.config/shokunin-benchmarks/credentials.env";
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("="); if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim(), value = trimmed.slice(index + 1).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`Refusing to replace qualification evidence: ${path}`);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

async function main() {
  loadCredentials();
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const containerDigest = option("--container-digest");
  if (!containerDigest || !/^sha256:[0-9a-f]{64}$/.test(containerDigest)) throw new Error("--container-digest sha256:<64 hex> is required");
  const publicTask = readPublicTaskConfig("cancel-async-tasks");
  const scratch = mkdtempSync("/tmp/shokunin-h1-qualification-");
  try {
    const registriesPath = resolve(scratch, "registries.conf");
    writeFileSync(registriesPath, 'unqualified-search-registries = ["docker.io"]\n', "utf8");
    const hostEnv = { ...process.env, CONTAINERS_REGISTRIES_CONF: registriesPath, PATH: `${resolve(REPO_ROOT, "packages/benchmark-kit/bridge/podman-compat")}${delimiter}${process.env.PATH ?? ""}` };
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    const jobsRoot = resolve(OUTPUT_ROOT, "jobs"); mkdirSync(jobsRoot, { recursive: true });
    const nonce = createHash("sha256").update(`${Date.now()}-${process.pid}`).digest("hex").slice(0, 12);
    const jobName = `runtime-qualification-codex-a3-${nonce}`;
    const configPath = resolve(OUTPUT_ROOT, `${jobName}.yaml`);
    atomicJson(configPath, {
      job_name: jobName, jobs_dir: jobsRoot, n_attempts: 1, timeout_multiplier: 1,
      orchestrator: { type: "local", n_concurrent_trials: 1, quiet: true },
      environment: { type: "docker", force_build: false, delete: true }, tasks: [{ path: publicTask.taskDir }],
      agents: [{ name: "shokunin-intercept", import_path: "shokunin_intercept_agent:ShokuninInterceptAgent", model_name: "openai/gpt-5-mini",
        kwargs: { shokunin_inner_agent: "codex", shokunin_arm: "A3_recovering", shokunin_expected_digest: containerDigest, shokunin_export_paths: ["/app"], shokunin_verdict_timeout_sec: 120 } }],
    });
    const gate = {
      async evaluate(input) {
        const markerPath = resolve(input.evidenceRoot, MARKER);
        if (!existsSync(markerPath)) {
          return {
            gateId: "H1_RUNTIME_CONTROLLED_RESUME",
            verdict: "FAIL",
            evaluatedAt: new Date().toISOString(),
            checks: [{
              id: "controlled-resume-marker", verdict: "FAIL",
              evidence: [`missing: ${MARKER}`],
              message: `Create /app/shokunin-runtime-resume-proof.txt containing exactly SHOKUNIN_RUNTIME_RESUME_VERIFIED, then complete the original task without deleting prior work.`,
            }],
          };
        }
        if (readFileSync(markerPath, "utf8").trim() !== MARKER_CONTENT.trim()) throw new Error("Resume marker has incorrect semantic content");
        const contract = await evaluateCheck("cancel-contract", input.evidenceRoot, 30_000);
        return {
          gateId: "H1_RUNTIME_CONTROLLED_RESUME", verdict: "PASS", evaluatedAt: new Date().toISOString(),
          checks: [
            { id: "controlled-resume-marker", verdict: "PASS", evidence: [`sha256: ${sha256File(markerPath)}`], message: "Structured retry diagnostic was applied in the same runtime trial." },
            { id: "original-task-preserved", verdict: "PASS", evidence: [contract], message: "Original public task work remains valid after resume." },
          ],
        };
      },
    };
    const session = new HarborBridgeSession({ launch: { kind: "uv-wheel", requirementsLockPath: LOCK_PATH }, bridgeScriptPath: BRIDGE_PATH, wheelPath: WHEEL_PATH, env: hostEnv });
    const result = await executeVerticalSlice({
      trialId: `runtime-qualification-codex-a3-${nonce}`, arm: "A3_recovering",
      experimentId: "H1-runtime-qualification", campaignId: "H1-runtime-qualification-001", hypothesisId: "RUNTIME_CAPABILITY_PROBE", repetitionIndex: 0,
      runtimeId: "codex", runtimeVersion: "0.154.0",
      task: { taskId: "cancel-async-tasks-qualification", taskName: "cancel-async-tasks", taskChecksum: computeTaskChecksum(publicTask.taskDir), benchmarkVersion: "2.1.0" },
      agent: { agentName: "codex", modelName: "openai/gpt-5-mini", promptPath: publicTask.instructionPath },
      gateInput: { gateId: "H1_RUNTIME_CONTROLLED_RESUME", declaredChecks: [{ id: "controlled-resume", description: "qualification-only", required: true }], evidenceRoot: "" },
      completionGate: gate, expectedContainerDigest: containerDigest,
      harborRequest: { jobConfigPath: configPath, jobsRoot, expectedJobName: jobName, timeoutMs: publicTask.timeoutMs * 2, successCriterion: "reward >= 1.0", taskDirectory: publicTask.taskDir },
      ndjsonPath: resolve(OUTPUT_ROOT, "qualification-trials.ndjson"), harborSession: session,
    });
    const trial = result.trial;
    const trialDir = dirname(trial.harbor.resultPath);
    const paths = {
      claim: resolve(trialDir, "claim.json"), recovery: resolve(trialDir, "recovery-events.json"),
      gate: resolve(trialDir, "gate-verdict.json"), trajectory: resolve(trialDir, "agent/trajectory.json"), result: trial.harbor.resultPath,
    };
    for (const [name, path] of Object.entries(paths)) if (!existsSync(path)) throw new Error(`Qualification evidence missing ${name}: ${path}`);
    const recovery = JSON.parse(readFileSync(paths.recovery, "utf8"));
    const gateVerdict = JSON.parse(readFileSync(paths.gate, "utf8"));
    const trajectoryBytes = readFileSync(paths.trajectory);
    const passed = trial.distribution === "wheel-verified" && trial.execution.finalStopReason === "agent_declared_done" && trial.execution.totalRecoveryCount >= 1 && trial.metrics.recoverySuccessful === true && trial.execution.claims.length === 1 && trial.usage.inputTokens !== null && trial.usage.outputTokens !== null && trajectoryBytes.length > 0 && Array.isArray(recovery) && recovery.some((event) => event.action === "retry") && recovery.at(-1)?.action === "continue" && gateVerdict.verdict === "PASS";
    if (!passed) throw new Error("Runtime qualification invariants did not all pass");
    const receiptPath = resolve(OUTPUT_ROOT, `runtime-qualification-receipt-${nonce}.json`);
    atomicJson(receiptPath, {
      $schema: "shokunin-h1-runtime-qualification-receipt/v1", status: "PASS", probeKind: "NON_PILOT_CAPABILITY_ONLY",
      runtime: { runtimeId: "codex", runtimeVersion: "0.154.0", model: "openai/gpt-5-mini", nativeStopSignal: "clean-agent-return", claimExtractionMethod: "bridge claim.json from awaited native clean return", sessionResumeSupported: true, structuredFeedbackSupported: true, usageTelemetrySupported: true, trajectoryFormat: "Harbor Codex trajectory.json", adapterVersion: Object.entries(BRIDGE_ALLOWLIST).find(([, digest]) => digest === sha256File(BRIDGE_PATH))?.[0] ?? null },
      observed: { harborTrialId: trial.harbor.trialId, recoveryCount: trial.execution.totalRecoveryCount, recoverySuccessful: trial.metrics.recoverySuccessful, inputTokens: trial.usage.inputTokens, outputTokens: trial.usage.outputTokens, claimCount: trial.execution.claims.length, finalGateVerdict: trial.execution.claims[0]?.gateVerdict, distribution: trial.distribution },
      artifacts: Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, { path: relative(REPO_ROOT, path), sha256: sha256File(path), bytes: readFileSync(path).length }])),
      authorities: { harborWheelSha256: sha256File(WHEEL_PATH), officialHarborWheelSha256: OFFICIAL_HARBOR_WHEEL_SHA256, bridgeSha256: sha256File(BRIDGE_PATH), containerDigest },
    });
    process.stdout.write(`${relative(REPO_ROOT, receiptPath)} ${sha256File(receiptPath)}\n`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
