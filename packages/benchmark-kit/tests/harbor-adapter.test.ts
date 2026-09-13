import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import yaml from "yaml";

import {
  LocalCommandExecutor,
  type CommandExecutionResult,
  type CommandRequest,
  type ICommandExecutor,
  type GateEvaluationInput,
} from "@shokunin/core";
import type { HarborJobRequest } from "../contracts/harbor.contract.js";
import { ActionableBenchmarkError } from "../src/errors/actionable-error.js";
import {
  HarborAdapter,
  evaluateSuccessCriterion,
} from "../src/adapters/harbor-adapter.js";
import {
  HarborBridgeSession,
  type HarborBridgeSessionOptions,
} from "../src/sessions/harbor-bridge-session.js";
import { SessionLedger } from "../src/persistence/session-ledger.js";
import { computeTaskChecksum } from "../src/crypto/dirhash.js";
import { executeVerticalSlice, makeWritableRecursive, type VerticalSliceResult } from "../src/integration/vertical-slice.js";

const R4_TEST_DIGEST = "sha256:ba5e000000000000000000000000000000000000000000000000000000000000";
const R4_BENCHMARK_VERSION = "2.1.0-test";

const BRIDGE_IMPORT = "shokunin_intercept_agent:ShokuninInterceptAgent";

function writeOracleManifest(
  manifestPath: string,
  arm: "A0_baseline" | "A1_observing" | "A2_blocking" = "A0_baseline",
  digest: string = R4_TEST_DIGEST,
  modelName = "oracle-v1",
): void {
  writeFileSync(
    manifestPath,
    `job_name: oracle-job\n` +
      `agents:\n` +
      `  - name: shokunin-intercept\n` +
      `    import_path: ${BRIDGE_IMPORT}\n` +
      `    model_name: ${modelName}\n` +
      `    kwargs:\n` +
      `      shokunin_inner_agent: oracle\n` +
      `      shokunin_arm: ${arm}\n` +
      `      shokunin_expected_digest: ${digest}\n` +
      `      shokunin_verdict_timeout_sec: 20\n` +
      `tasks:\n` +
      `  - path: oracle-task\n`,
  );
}


function r4Provenance(trialId: string) {
  return {
    experimentId: "exp-r4-test",
    campaignId: "campaign-r4-test",
    hypothesisId: "H1_COMPLIANCE_GATE",
    repetitionIndex: 0,
    runtimeId: "test-runtime",
    runtimeVersion: "0.0.0-test",
  };
}

interface BridgeSimSpec {
  jobDir: string;
  trialDir: string;
  jobId: string;
  trialUuid: string;
  trialName?: string | undefined;
  reward?: number | undefined;
  behavior?: "clean" | "timeout" | "error" | undefined;
  arm: "A0_baseline" | "A1_observing" | "A2_blocking";
  agentName?: string | undefined;
  agentModel?: string | null | undefined;
  agentProvider?: string | undefined;
  configuredModel?: string | undefined;
  snapshotFiles?: Record<string, string> | undefined;
  snapshotSymlinks?: Record<string, string> | undefined;
  containerDigest?: string | undefined;
  containerId?: string | undefined;
  taskChecksum?: string | undefined;
  verdictTimeoutMs?: number | undefined;
  trialUriOverride?: string | undefined;
  patchResult?: ((payload: Record<string, unknown>) => void) | undefined;
  claimOverride?: Record<string, unknown> | null | undefined;
  outcomeExtra?: Record<string, unknown> | null | undefined;
  gateRequestOverride?: Record<string, unknown> | undefined;
}

/**
 * Simulates a bridge-carrying Harbor run inside a mock executor: Harbor-topology
 * trial directory (agent/, verifier/, config.json), bridge sidecars
 * (claim/outcome, container-identity, workspace-snapshot, export manifest,
 * harbor-version), live gate handshake (writes gate-request.json then POLLS
 * for the verdict the REAL session code serves), and the final verdict-shaped
 * result.json. Hand-written bytes only — never production helpers.
 */
async function simulateBridgeRun(spec: BridgeSimSpec): Promise<void> {
  const {
    jobDir,
    trialDir,
    jobId,
    trialUuid,
    trialName = "trial-1",
    reward = 1.0,
    behavior = "clean",
    arm,
    agentName = "oracle",
    agentModel = undefined,
    agentProvider = "test",
    configuredModel = "oracle-v1",
    snapshotFiles = { "solution.txt": "simulated live-container solution bytes" },
    snapshotSymlinks = {},
    containerDigest = R4_TEST_DIGEST,
    containerId = "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    taskChecksum = authenticOracleChecksum,
    verdictTimeoutMs = 15000,
    trialUriOverride = undefined,
    patchResult = undefined,
    claimOverride = undefined,
    outcomeExtra = undefined,
    gateRequestOverride = undefined,
  } = spec;
  const now = (): string => new Date().toISOString();
  // Official Harbor form: trials with exception_info count n_errors.
  const jobErrors = behavior === "clean" ? 0 : 1;
  writeFileSync(
    join(jobDir, "result.json"),
    JSON.stringify({
      id: jobId,
      started_at: now(),
      finished_at: now(),
      n_total_trials: 1,
      stats: { n_trials: 1, n_errors: jobErrors },
    }),
  );
  writeFileSync(
    join(jobDir, "harbor-version.json"),
    JSON.stringify({ version: "0.1.2", source: "importlib" }),
  );
  await simulateBridgeTrial({
    trialDir,
    trialName,
    jobId,
    trialUuid,
    reward,
    behavior,
    arm,
    agentName,
    agentModel,
    agentProvider,
    configuredModel,
    snapshotFiles,
    snapshotSymlinks,
    containerDigest,
    containerId,
    taskChecksum,
    verdictTimeoutMs,
    trialUriOverride,
    patchResult,
    claimOverride,
    outcomeExtra,
    gateRequestOverride,
  });
  // Official Harbor form for A2 blocks (R7 item 4): the blocked trial
  // carries ShokuninGateBlocked AND the job counts n_errors = 1. The
  // gate-blocked.json prevention marker is written by the bridge.
  if (arm === "A2_blocking" && behavior === "clean") {
    try {
      const verdictRaw = readFileSync(join(trialDir, "gate-verdict.json"), "utf8");
      const verdict = (JSON.parse(verdictRaw) as { verdict?: unknown }).verdict;
      if (verdict === "BLOCK") {
        writeFileSync(
          join(trialDir, "gate-blocked.json"),
          JSON.stringify({ trialName, at: new Date().toISOString(), verdict: { verdict } }),
        );
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: jobId,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 1 },
          }),
        );
      }
    } catch {
      // No verdict (e.g. unit probes): leave the initial job result.
    }
  }
}

interface BridgeTrialSpec {
  trialDir: string;
  trialName?: string | undefined;
  jobId: string;
  trialUuid: string;
  reward?: number | undefined;
  behavior?: "clean" | "timeout" | "error" | undefined;
  arm: "A0_baseline" | "A1_observing" | "A2_blocking";
  agentName?: string | undefined;
  agentModel?: string | null | undefined;
  agentProvider?: string | undefined;
  configuredModel?: string | undefined;
  snapshotFiles?: Record<string, string> | undefined;
  snapshotSymlinks?: Record<string, string> | undefined;
  containerDigest?: string | undefined;
  containerId?: string | undefined;
  taskChecksum?: string | undefined;
  verdictTimeoutMs?: number | undefined;
  trialUriOverride?: string | undefined;
  patchResult?: ((payload: Record<string, unknown>) => void) | undefined;
  claimOverride?: Record<string, unknown> | null | undefined;
  outcomeExtra?: Record<string, unknown> | null | undefined;
  gateRequestOverride?: Record<string, unknown> | undefined;
}

/** Trial-level bridge simulation (no job files): for multi-trial jobs. */
async function simulateBridgeTrial(spec: BridgeTrialSpec): Promise<void> {
  const {
    trialDir,
    trialName = "trial-1",
    jobId,
    trialUuid,
    reward = 1.0,
    behavior = "clean",
    arm,
    agentName = "oracle",
    agentModel = undefined,
    agentProvider = "test",
    configuredModel = "oracle-v1",
    snapshotFiles = { "solution.txt": "simulated live-container solution bytes" },
    snapshotSymlinks = {},
    containerDigest = R4_TEST_DIGEST,
    containerId = "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    taskChecksum = authenticOracleChecksum,
    verdictTimeoutMs = 15000,
    trialUriOverride = undefined,
    patchResult = undefined,
    claimOverride = undefined,
    outcomeExtra = undefined,
    gateRequestOverride = undefined,
  } = spec;
  const now = (): string => new Date().toISOString();
  mkdirSync(join(trialDir, "agent"), { recursive: true });
  mkdirSync(join(trialDir, "verifier"), { recursive: true });
  writeFileSync(
    join(trialDir, "config.json"),
    JSON.stringify({
      job_id: jobId,
      task: { path: "oracle-task" },
      agent: {
        name: "shokunin-intercept",
        import_path: BRIDGE_IMPORT,
        model_name: configuredModel,
        kwargs: {
          shokunin_inner_agent: "oracle",
          shokunin_arm: arm,
          shokunin_expected_digest: containerDigest,
        },
      },
    }),
  );
  // R8 mutation hooks let adversarial tests forge, duplicate or cross-bind
  // sidecars. undefined = default bridge behavior; null (where supported) =
  // omit the file even when the behavior would write it.
  if (claimOverride !== undefined) {
    if (claimOverride !== null) {
      writeFileSync(join(trialDir, "claim.json"), JSON.stringify(claimOverride));
    }
  } else if (behavior === "clean") {
    writeFileSync(
      join(trialDir, "claim.json"),
      JSON.stringify({ declaredDone: true, observedAt: now(), trialName }),
    );
  }
  const defaultOutcome =
    behavior === "clean"
      ? null
      : {
          declaredDone: false,
          reason: behavior === "timeout" ? "agent_timeout" : "agent_error",
          ...(behavior === "error" ? { message: "simulated agent failure" } : {}),
          observedAt: now(),
          trialName,
        };
  const outcomeToWrite = outcomeExtra !== undefined ? outcomeExtra : defaultOutcome;
  if (outcomeToWrite !== null) {
    writeFileSync(join(trialDir, "agent-outcome.json"), JSON.stringify(outcomeToWrite));
  }
  writeFileSync(
    join(trialDir, "container-identity.json"),
    JSON.stringify({
      containerId,
      containerName: `${trialName}-main-1`,
      imageId: containerDigest,
      imageRef: "oracle-task:latest",
      repoDigests: [containerDigest],
      inspectedAt: now(),
    }),
  );
  const snapDir = join(trialDir, "workspace-snapshot");
  mkdirSync(snapDir, { recursive: true });
  for (const [rel, content] of Object.entries(snapshotFiles)) {
    const dest = join(snapDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  const { symlinkSync: makeLink } = await import("node:fs");
  for (const [rel, target] of Object.entries(snapshotSymlinks)) {
    makeLink(target, join(snapDir, rel));
  }
  writeFileSync(
    join(trialDir, "export-manifest.json"),
    JSON.stringify({ exported: ["/solution"], missing: ["/app", "/workspace"], at: now() }),
  );

  // Live gate handshake for governed arms with a claim (the real session
  // under test serves the verdict concurrently).
  let verdict: string | null = null;
  if ((arm === "A1_observing" || arm === "A2_blocking") && behavior === "clean") {
    writeFileSync(
      join(trialDir, "gate-request.json"),
      JSON.stringify(
        gateRequestOverride ?? { trialName, arm, snapshotDir: snapDir, createdAt: now() },
      ),
    );
    const deadline = Date.now() + verdictTimeoutMs;
    for (;;) {
      const verdictPath = join(trialDir, "gate-verdict.json");
      if (existsSync(verdictPath)) {
        verdict = (JSON.parse(readFileSync(verdictPath, "utf8")) as { verdict?: unknown }).verdict as string;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`gate verdict never arrived in simulation for ${trialName}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  const agentExec = {
    started_at: new Date(Date.now() - 1500).toISOString(),
    finished_at: new Date(Date.now() - 500).toISOString(),
  };
  const agentInfo: Record<string, unknown> = { name: agentName, version: "1.0.0" };
  if (agentModel !== undefined && agentModel !== null) {
    agentInfo["model_info"] = { name: agentModel, provider: agentProvider };
  }
  const blocked = arm === "A2_blocking" && verdict === "BLOCK";
  if (blocked) {
    writeFileSync(
      join(trialDir, "gate-blocked.json"),
      JSON.stringify({ trialName, at: now(), verdict: { verdict } }),
    );
  }
  const resultPayload: Record<string, unknown> = {
    id: trialUuid,
    task_name: "oracle-task",
    trial_name: trialName,
    trial_uri: trialUriOverride ?? "file://" + trialDir,
    task_id: { path: "oracle-task" },
    task_checksum: taskChecksum,
    config: {
      task: { path: "oracle-task" },
      agent: {
        name: "shokunin-intercept",
        import_path: BRIDGE_IMPORT,
        model_name: configuredModel,
        kwargs: { shokunin_inner_agent: "oracle", shokunin_arm: arm },
      },
      job_id: jobId,
    },
    agent_info: agentInfo,
    agent_execution: agentExec,
    finished_at: now(),
  };
  if (blocked) {
    resultPayload["verifier"] = null;
    resultPayload["verifier_result"] = null;
    resultPayload["exception_info"] = {
      exception_type: "ShokuninGateBlocked",
      exception_message: `A2 gate BLOCKED trial ${trialName}; verifier will not start`,
      exception_traceback: "",
      occurred_at: now(),
    };
  } else if (behavior === "timeout") {
    resultPayload["verifier"] = {
      started_at: now(),
      finished_at: now(),
    };
    resultPayload["verifier_result"] = { rewards: { reward } };
    resultPayload["exception_info"] = {
      exception_type: "AgentTimeoutError",
      exception_message: `Agent execution timed out for ${trialName}`,
      exception_traceback: "",
      occurred_at: now(),
    };
  } else if (behavior === "error") {
    resultPayload["verifier"] = null;
    resultPayload["verifier_result"] = null;
    resultPayload["exception_info"] = {
      exception_type: "RuntimeError",
      exception_message: "simulated agent failure",
      exception_traceback: "",
      occurred_at: now(),
    };
  } else {
    resultPayload["verifier"] = {
      started_at: now(),
      finished_at: now(),
    };
    resultPayload["verifier_result"] = { rewards: { reward } };
  }
  if (patchResult) {
    patchResult(resultPayload);
  }
  writeFileSync(join(trialDir, "result.json"), JSON.stringify(resultPayload));
}

function newBridgeSession(
  executor: ICommandExecutor,
  overrides?: Partial<HarborBridgeSessionOptions>,
): HarborBridgeSession {
  return new HarborBridgeSession({
    executor,
    launch: { kind: "plain", executable: "harbor" },
    bridgeScriptPath: BRIDGE_SCRIPT,
    wheelPath: wheelPath,
    ...(overrides ?? {}),
  });
}

function cleanupTestDir(tempDir: string, result?: { snapshotDirectory?: string | undefined }): void {
  try {
    if (result?.snapshotDirectory && existsSync(result.snapshotDirectory)) {
      makeWritableRecursive(result.snapshotDirectory);
    }
  } catch { /* ignore */ }
  try {
    makeWritableRecursive(tempDir);
  } catch { /* ignore */ }
  rmSync(tempDir, { recursive: true, force: true });
}
import { NDJsonStore } from "../src/persistence/ndjson-store.js";
import { benchmarkTrialSchema } from "../schemas/trial.schema.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(thisDir, "../..");
const fixturesDir = resolve(packageRoot, "tests/fixtures/harbor");
const lockPath = resolve(fixturesDir, "requirements.lock");
const wheelPath = resolve(fixturesDir, "vendor/harbor-0.1.2-py3-none-any.whl");
const BRIDGE_SCRIPT = resolve(packageRoot, "bridge/shokunin_intercept_agent.py");
const PYTHON_NO_BYTECODE_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };

const authenticOracleChecksum = "19fc07d660632466aca155fbd818e25ad479f92bc409c4fcdbfaafcc982a5dd1";

class MockCommandExecutor implements ICommandExecutor {
  constructor(
    private readonly handler: (req: CommandRequest) => Promise<CommandExecutionResult>,
  ) {}

  async execute(request: CommandRequest): Promise<CommandExecutionResult> {
    return this.handler(request);
  }
}

function createDummyResult(
  exitCode: number | null = 0,
  timedOut = false,
  stdout = "",
  stderr = "",
): CommandExecutionResult {
  return {
    exitCode,
    signal: null,
    stdout,
    stderr,
    durationMs: 10,
    timedOut,
  };
}

const GENUINE_HARBOR_HELP =
  "Usage: harbor [OPTIONS] COMMAND [ARGS]...\n\n  Harbor CLI\n\nCommands:\n  jobs\n  tasks\n  trials\n  run\n  sweeps\n";
const GENUINE_RUN_HELP =
  "Usage: harbor run [OPTIONS]\n\nOptions:\n  -c, --config PATH  Path to job configuration file.\n";

function probeRoute(req: CommandRequest): CommandExecutionResult | null {
  const args = req.args ?? [];
  if (req.command === "docker" || req.command === "podman") {
    if (args.includes("info")) {
      return createDummyResult(0, false, "Docker version 27.0.0, build test-double");
    }
    const dm = args.map(String).join(" ").match(/sha256:[0-9a-f]{64}/i);
    if (args.includes("inspect") && dm) {
      return createDummyResult(0, false, JSON.stringify([{ RepoDigests: [`oracle-task@${dm[0]}`] }]));
    }
    return createDummyResult(0, false, "Docker version 27.0.0, build test-double");
  }
  const cmd = req.command ?? "";
  if (cmd === "docker" || cmd === "podman") {
    if (args.includes("info")) {
      return createDummyResult(0, false, "Docker version 27.0.0, build test-double");
    }
    const dm = args.map(String).join(" ").match(/sha256:[0-9a-f]{64}/i);
    if (args.includes("inspect") && dm) {
      return createDummyResult(0, false, JSON.stringify([{ RepoDigests: [`oracle-task@${dm[0]}`] }]));
    }
    return createDummyResult(0, false, "Docker version 27.0.0, build test-double");
  }
  // Exact probe shapes for any launcher command (plain `harbor`, absolute
  // paths, or the uv module form `... python3 -m harbor.cli.sb.main --help`).
  // The real `run -c <manifest>` invocation (ends with the manifest path)
  // always falls through to the file-writing branch.
  const lastTwo = args.slice(-2);
  if (lastTwo.length === 2 && lastTwo[0] === "run" && lastTwo[1] === "--help") {
    return createDummyResult(0, false, GENUINE_RUN_HELP);
  }
  if (args.length >= 1 && args[args.length - 1] === "--help") {
    return createDummyResult(0, false, GENUINE_HARBOR_HELP);
  }
  // importlib version probe of uv-form launchers (pinned 0.1.2).
  if (args.includes("-c") && args.map(String).join(" ").includes("importlib")) {
    return createDummyResult(0, false, "0.1.2");
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. evaluateSuccessCriterion Tests
// ---------------------------------------------------------------------------

test("evaluateSuccessCriterion: parses and evaluates comparison expressions", () => {
  const rewards = { reward: 1.0, quality: 0.8 };
  assert.equal(evaluateSuccessCriterion(rewards, "reward >= 1.0"), true);
  assert.equal(evaluateSuccessCriterion(rewards, "reward >= 1.5"), false);
  assert.equal(evaluateSuccessCriterion(rewards, "quality > 0.5"), true);
  assert.equal(evaluateSuccessCriterion(rewards, "quality <= 0.8"), true);
  assert.equal(evaluateSuccessCriterion(rewards, "reward == 1.0"), true);
  assert.equal(evaluateSuccessCriterion(rewards, "reward != 1.0"), false);
});

test("evaluateSuccessCriterion: throws ActionableBenchmarkError when reward key is missing", () => {
  const rewards = { other: 1.0 };
  assert.throws(
    () => evaluateSuccessCriterion(rewards, "reward >= 1.0"),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "RESULT_INVALID");
      assert.match(err.message, /Required reward key ["']reward["'] missing/);
      return true;
    },
  );
});

test("evaluateSuccessCriterion: throws ActionableBenchmarkError on invalid operator", () => {
  const rewards = { reward: 1.0 };
  assert.throws(
    () => evaluateSuccessCriterion(rewards, "reward ~~ 1.0"),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "CONFIG_INVALID");
      return true;
    },
  );
});

test("evaluateSuccessCriterion: MUTATION MALFORMED_NUMERIC_CRITERION_REJECTED - strictly rejects multi-dot numbers like '1..0'", () => {
  const rewards = { reward: 1.0 };
  for (const badCriterion of [
    "reward >= 1..0",
    "reward >= 1.",
    "reward >= .5",
    "reward >= 1.2.3",
    "reward == abc",
  ]) {
    assert.throws(
      () => evaluateSuccessCriterion(rewards, badCriterion),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Invalid successCriterion format/);
        return true;
      },
      `Expected ${badCriterion} to be rejected with CONFIG_INVALID`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Preflight Fail-Closed Tests
// ---------------------------------------------------------------------------

test("preflight: MUTATION NONZERO_PREFLIGHT_ACCEPTED - fails closed when harbor check exits with code 127 and stderr", async () => {
  const mockExecutor = new MockCommandExecutor(async () => {
    return createDummyResult(127, false, "", "bash: harbor: command not found");
  });

  const adapter = new HarborAdapter({
    harborExecutable: "harbor",
    executor: mockExecutor,
  });

  await assert.rejects(
    () => adapter.preflight({ checkHarbor: true, checkContainerRuntime: false }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "HARNESS_UNAVAILABLE");
      assert.match(err.message, /Harbor preflight failed with exit code 127/);
      return true;
    },
  );
});

test("preflight: throws HARNESS_UNAVAILABLE when harbor check times out", async () => {
  const mockExecutor = new MockCommandExecutor(async () => {
    return createDummyResult(null, true, "", "");
  });

  const adapter = new HarborAdapter({
    harborExecutable: "harbor",
    executor: mockExecutor,
  });

  await assert.rejects(
    () => adapter.preflight({ checkHarbor: true, checkContainerRuntime: false }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "HARNESS_UNAVAILABLE");
      assert.match(err.message, /Harbor preflight check timed out/);
      return true;
    },
  );
});

test("preflight: throws INFRASTRUCTURE_FAILURE when container runtime is unavailable", async () => {
  const mockExecutor = new MockCommandExecutor(async (req) => {
    if (req.command === "harbor") {
      if (req.args?.includes("run")) {
        return createDummyResult(0, false, "Usage: harbor run [OPTIONS]\n\nOptions:\n  -c, --config PATH\n");
      }
      return createDummyResult(
        0,
        false,
        "Usage: harbor [OPTIONS] COMMAND [ARGS]...\n\n  Harbor CLI version 0.1.2\n\nCommands:\n  jobs\n  tasks\n  trials\n  run\n  sweeps\n",
      );
    }
    return createDummyResult(1, false, "", "Cannot connect to the Docker daemon");
  });

  const adapter = new HarborAdapter({
    harborExecutable: "harbor",
    executor: mockExecutor,
  });

  await assert.rejects(
    () => adapter.preflight({ checkHarbor: true, checkContainerRuntime: true }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "INFRASTRUCTURE_FAILURE");
      assert.match(err.message, /No responsive container engine found/);
      return true;
    },
  );
});

test("preflight: MUTATION UNPINNED_HARBOR_VERSION_REJECTED - rejects unpinned versions and fake executables", async () => {
  // 1. Fake executable advertising not-the-official-harbor
  const fakeExecutor = new MockCommandExecutor(async () => {
    return createDummyResult(0, false, "not-the-official-harbor version 9.9.9");
  });
  const fakeAdapter = new HarborAdapter({ executor: fakeExecutor });
  await assert.rejects(
    () => fakeAdapter.preflight({ checkHarbor: true, checkContainerRuntime: false }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "HARNESS_UNAVAILABLE");
      assert.match(err.message, /did not respond with genuine Harbor CLI/);
      return true;
    },
  );

  // 2. Official-looking CLI but unpinned version 9.9.9
  const unpinnedExecutor = new MockCommandExecutor(async (req) => {
    if (req.args?.includes("run")) {
      return createDummyResult(0, false, "Usage: harbor run [OPTIONS]\n\nOptions:\n  -c, --config PATH\n");
    }
    return createDummyResult(
      0,
      false,
      "Usage: harbor [OPTIONS] COMMAND [ARGS]...\n\n  Harbor CLI version 9.9.9\n\nCommands:\n  jobs\n  tasks\n  trials\n  run\n  sweeps\n",
    );
  });
  const unpinnedAdapter = new HarborAdapter({ executor: unpinnedExecutor });
  await assert.rejects(
    () => unpinnedAdapter.preflight({ checkHarbor: true, checkContainerRuntime: false }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "HARNESS_UNAVAILABLE");
      assert.match(err.message, /Harbor version mismatch/);
      return true;
    },
  );
});

test("preflight: MUTATION FORGED_BANNER_REJECTED - rejects forged harbor executable banner", async () => {
  const forgedExecutor = new MockCommandExecutor(async () => {
    return createDummyResult(0, false, "Harbor CLI v0.1.2 forged executable");
  });
  const forgedAdapter = new HarborAdapter({ executor: forgedExecutor });
  await assert.rejects(
    () => forgedAdapter.preflight({ checkHarbor: true, checkContainerRuntime: false }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "HARNESS_UNAVAILABLE");
      assert.match(err.message, /genuine Harbor Typer CLI structure/);
      return true;
    },
  );
});

test("preflight: succeeds when both genuine pinned harbor (0.1.2) and container engine respond", async () => {
  const mockExecutor = new MockCommandExecutor(async (req) => {
    if (req.command === "harbor") {
      if (req.args?.includes("run")) {
        return createDummyResult(0, false, "Usage: harbor run [OPTIONS]\n\nOptions:\n  -c, --config PATH  Path to job configuration file.\n");
      }
      return createDummyResult(
        0,
        false,
        "Usage: harbor [OPTIONS] COMMAND [ARGS]...\n\n  Harbor CLI version 0.1.2\n\nCommands:\n  jobs    Manage jobs.\n  run     Start a job.\n  sweeps  Run successive sweeps.\n  tasks   Manage tasks.\n  traces  Trace export utilities.\n  trials  Manage trials.\n",
      );
    }
    if (req.command === "docker") {
      return createDummyResult(0, false, "Docker version 27.0.0");
    }
    return createDummyResult(1);
  });

  const adapter = new HarborAdapter({
    harborExecutable: "harbor",
    executor: mockExecutor,
  });

  const status = await adapter.preflight({ checkHarbor: true, checkContainerRuntime: true });
  assert.equal(status.harborAvailable, true);
  assert.equal(status.harborVersion, "0.1.2");
  assert.equal(status.containerRuntime, "docker");
  assert.equal(status.containerRuntimeVersion, "Docker version 27.0.0");
});

// ---------------------------------------------------------------------------
// 3. Request Validation & Path Confinement Tests
// ---------------------------------------------------------------------------

test("run: rejects non-existent jobConfigPath with CONFIG_INVALID", async () => {
  const adapter = new HarborAdapter({ executor: new MockCommandExecutor(async () => createDummyResult(0)) });

  await assert.rejects(
    () =>
      adapter.run({
        jobConfigPath: "/missing/config.yaml",
        jobsRoot: "/tmp",
        expectedJobName: "test-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      }),
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "CONFIG_INVALID");
      assert.match(err.message, /Manifest file not found/);
      return true;
    },
  );
});

test("run: rejects invalid timeoutMs with CONFIG_INVALID", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-test-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(manifestPath, "tasks:\n  - path: /tmp/task\nagents:\n  - name: oracle\n");
    const adapter = new HarborAdapter({ executor: new MockCommandExecutor(async () => createDummyResult(0)) });

    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "test",
          timeoutMs: -1,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /timeoutMs must be a positive finite number/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION PATH_ESCAPE_ACCEPTED - rejects traversal expectedJobName: '../outside'", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-test-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(manifestPath, "tasks:\n  - path: /tmp/task\nagents:\n  - name: oracle\n");
    const adapter = new HarborAdapter({ executor: new MockCommandExecutor(async () => createDummyResult(0)) });

    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "../outside",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Path escape detected/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION MANDATORY_CHECKSUM_AUTHORITY_REJECTED - rejects request with no checksum authority or absent taskDirectory", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-chk-auth-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(manifestPath, "tasks:\n  - path: /tmp/task\nagents:\n  - name: oracle\n");
    const adapter = new HarborAdapter({ executor: new MockCommandExecutor(async () => createDummyResult(0)) });

    // 1. Missing both authorities
    await assert.rejects(
      () =>
        // @ts-expect-error Testing runtime fail-closed when caller bypasses TypeScript discriminated union
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Mandatory checksum authority missing/);
        return true;
      },
    );

    // 2. Non-existent task directory
    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          taskDirectory: join(tempDir, "non-existent-task"),
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Task directory not found/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. Timeout & Process Tree Kill Tests (including TIMEOUT_DESCENDANT_SURVIVED)
// ---------------------------------------------------------------------------

test("run: MUTATION TIMEOUT_DESCENDANT_SURVIVED - real LocalCommandExecutor kills entire process tree and zero descendants survive", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-descendant-test-"));
  const markerFile = join(tempDir, "descendant-marker.txt");
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir, { recursive: true });

  // Faithful launcher double: answers genuine CLI probes, hangs otherwise.
  const hangScript = join(binDir, "hang-harbor.sh");
  writeFileSync(
    hangScript,
    [
      "#!/bin/bash",
      "has_help=0; has_run=0",
      'for a in "$@"; do',
      '  [ "$a" = "--help" ] && has_help=1',
      '  [ "$a" = "run" ] && has_run=1',
      "done",
      'if [ "$has_help" = "1" ]; then',
      '  if [ "$has_run" = "1" ]; then',
      "    printf 'Usage: harbor run [OPTIONS]\\n\\nOptions:\\n  -c, --config PATH  Path to job configuration file.\\n'",
      "  else",
      "    printf 'Usage: harbor [OPTIONS] COMMAND [ARGS]...\\n\\n  Harbor CLI\\n\\nCommands:\\n  jobs\\n  tasks\\n  trials\\n  run\\n  sweeps\\n'",
      "  fi",
      "  exit 0",
      "fi",
      `bash -c "(sleep 0.5 && touch '${markerFile}') & sleep 5"`,
    ].join("\n"),
  );
  chmodSync(hangScript, 0o755);
  const fakeDocker = join(binDir, "docker");
  writeFileSync(fakeDocker, "#!/bin/bash\necho 'Docker version 27.0.0, build test-double'\nexit 0\n");
  chmodSync(fakeDocker, 0o755);

  try {
    const executor = new LocalCommandExecutor();
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(manifestPath, "job_name: test-job\ntasks:\n  - path: /tmp/task\nagents:\n  - name: oracle\n");

    const adapter = new HarborAdapter({
      executor,
      harborExecutable: hangScript,
      containerRuntime: "docker",
      env: { PATH: `${binDir}:${process.env["PATH"] ?? ""}` },
    });

    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "test-job",
          timeoutMs: 150,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "TRIAL_TIMEOUT");
        return true;
      },
    );

    // Wait 700ms to verify background grandchild is dead and cannot touch marker
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(existsSync(markerFile), false, "Descendant process leaked and created marker file after timeout!");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Invariants, Freshness & Adversarial Mutations
// ---------------------------------------------------------------------------

test("run: MUTATION STALE_ARTIFACT_ACCEPTED - rejects pre-existing artifacts when executor is no-op", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-stale-test-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(manifestPath, "job_name: oracle-job\nagents:\n  - name: oracle\ntasks:\n  - path: /tmp/task\n");

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });

    const pastTime = (Date.now() - 60000) / 1000;
    const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

    writeFileSync(
      join(jobDir, "result.json"),
      JSON.stringify({
        id: jobId,
        started_at: new Date(Date.now() - 60000).toISOString(),
        finished_at: new Date(Date.now() - 59000).toISOString(),
        n_total_trials: 1,
        stats: { n_trials: 1, n_errors: 0 },
        trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
      }),
    );
    utimesSync(join(jobDir, "result.json"), pastTime, pastTime);

    writeFileSync(
      join(trialDir, "config.json"),
      JSON.stringify({ job_id: jobId }),
    );
    writeFileSync(
      join(trialDir, "result.json"),
      JSON.stringify({
        id: "e5f342af-b755-4208-9ebf-9f8dee679189",
        task_name: "oracle-task",
        trial_name: "trial-1",
        trial_uri: "file://" + trialDir,
        task_id: { path: "oracle-task" },
        task_checksum: authenticOracleChecksum,
        config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: jobId },
        agent_info: { name: "oracle", version: "1.0.0" },
        finished_at: new Date(Date.now() - 59000).toISOString(),
        verifier_result: { rewards: { reward: 1.0 } },
      }),
    );
    utimesSync(join(trialDir, "result.json"), pastTime, pastTime);

    const noOpExecutor = new MockCommandExecutor(async (req) => {
      const probe = probeRoute(req);
      if (probe) return probe;
      return createDummyResult(0);
    });
    const adapter = new HarborAdapter({ executor: noOpExecutor });

    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /Stale artifacts detected/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION TOUCH_ONLY_STALE_ACCEPTED - rejects pre-existing artifacts when executor merely updates mtime without modifying content", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-touch-test-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(manifestPath, "job_name: oracle-job\nagents:\n  - name: oracle\ntasks:\n  - path: /tmp/task\n");

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });

    const pastTime = (Date.now() - 60000) / 1000;
    const jobId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

    writeFileSync(
      join(jobDir, "result.json"),
      JSON.stringify({
        id: jobId,
        started_at: new Date(Date.now() - 60000).toISOString(),
        finished_at: new Date(Date.now() - 59000).toISOString(),
        n_total_trials: 1,
        stats: { n_trials: 1, n_errors: 0 },
        trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
      }),
    );
    utimesSync(join(jobDir, "result.json"), pastTime, pastTime);

    writeFileSync(
      join(trialDir, "config.json"),
      JSON.stringify({ job_id: jobId }),
    );
    writeFileSync(
      join(trialDir, "result.json"),
      JSON.stringify({
        id: "e5f342af-b755-4208-9ebf-9f8dee679189",
        task_name: "oracle-task",
        trial_name: "trial-1",
        trial_uri: "file://" + trialDir,
        task_id: { path: "oracle-task" },
        task_checksum: authenticOracleChecksum,
        config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: jobId },
        agent_info: { name: "oracle", version: "1.0.0" },
        finished_at: new Date(Date.now() - 59000).toISOString(),
        verifier_result: { rewards: { reward: 1.0 } },
      }),
    );
    utimesSync(join(trialDir, "result.json"), pastTime, pastTime);

    // Executor that ONLY touches mtimes to current time without updating file content
    const touchExecutor = new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
      const now = new Date();
      utimesSync(join(jobDir, "result.json"), now, now);
      utimesSync(join(trialDir, "result.json"), now, now);
      return createDummyResult(0);
    });
    const adapter = new HarborAdapter({ executor: touchExecutor });

    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /Stale artifacts detected/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION ZERO_TRIAL_JOB_ACCEPTED - rejects job result declaring 0 trials", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-zero-trial-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(manifestPath, "job_name: empty-job\nagents:\n  - name: oracle\ntasks:\n  - path: /tmp/task\n");

    const jobDir = join(tempDir, "empty-job");
    mkdirSync(jobDir, { recursive: true });

    const adapter = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 0,
            stats: { n_trials: 0, n_errors: 0 },
            trials: [],
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "empty-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /Zero-trial job rejected/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION WRONG_CHECKSUM_ACCEPTED - rejects 64 zeros and altered checksum fail-closed", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-checksum-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeOracleManifest(manifestPath);

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";

    // 1. Placeholder 64-zero hash
    const adapterWithZeros = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: jobId,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
          }),
        );
        writeFileSync(
          join(trialDir, "config.json"),
          JSON.stringify({ job_id: jobId }),
        );
        writeFileSync(
          join(trialDir, "result.json"),
          JSON.stringify({
            id: "e5f342af-b755-4208-9ebf-9f8dee679189",
            task_name: "oracle-task",
            trial_name: "trial-1",
            trial_uri: "file://" + trialDir,
            task_id: { path: "oracle-task" },
            task_checksum: "0".repeat(64),
            config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: jobId },
            agent_info: { name: "oracle", version: "1.0.0" },
            finished_at: new Date().toISOString(),
            verifier_result: { rewards: { reward: 1.0 } },
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapterWithZeros.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /placeholder task_checksum/);
        return true;
      },
    );

    // 2. Syntactically valid 64-char hash that does not match expected task checksum
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(trialDir, { recursive: true });
    const jobId2 = "bb6ea252-9817-4c82-b432-4f6bf957d3e4";
    const taskDir = resolve(fixturesDir, "oracle-task");
    const authenticChecksum = computeTaskChecksum(taskDir);
    assert.equal(authenticChecksum, authenticOracleChecksum);

    const adapterWithMismatchedHash = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: jobId2,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
          }),
        );
        writeFileSync(
          join(trialDir, "config.json"),
          JSON.stringify({ job_id: jobId2 }),
        );
        writeFileSync(
          join(trialDir, "result.json"),
          JSON.stringify({
            id: "e5f342af-b755-4208-9ebf-9f8dee679189",
            task_name: "oracle-task",
            trial_name: "trial-1",
            trial_uri: "file://" + trialDir,
            task_id: { path: "oracle-task" },
            task_checksum: "1111111111111111111111111111111111111111111111111111111111111111",
            config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: jobId2 },
            agent_info: { name: "oracle", version: "1.0.0" },
            finished_at: new Date().toISOString(),
            verifier_result: { rewards: { reward: 1.0 } },
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapterWithMismatchedHash.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          taskDirectory: taskDir,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /task_checksum mismatch/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION INCONSISTENT_CROSS_LINKS_REJECTED - rejects missing job_id, mismatched trial_name, and missing finished_at", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-crosslinks-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeOracleManifest(manifestPath);

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";

    // 1. Missing job_id in trial config.json
    const adapterMissingJobId = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: jobId,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
          }),
        );
        writeFileSync(join(trialDir, "config.json"), JSON.stringify({ task: { path: "oracle-task" } }));
        writeFileSync(
          join(trialDir, "result.json"),
          JSON.stringify({
            id: "e5f342af-b755-4208-9ebf-9f8dee679189",
            task_name: "oracle-task",
            trial_name: "trial-1",
            trial_uri: "file://" + trialDir,
            task_id: { path: "oracle-task" },
            task_checksum: authenticOracleChecksum,
            config: { task: { path: "oracle-task" }, agent: { name: "oracle" } },
            agent_info: { name: "oracle", version: "1.0.0" },
            finished_at: new Date().toISOString(),
            verifier_result: { rewards: { reward: 1.0 } },
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapterMissingJobId.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /missing mandatory job_id/);
        return true;
      },
    );

    // 2. Mismatched trial_name vs directory name
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(trialDir, { recursive: true });
    const jobId2 = "bb6ea252-9817-4c82-b432-4f6bf957d3e4";
    const adapterMismatchedTrialName = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: jobId2,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
          }),
        );
        writeFileSync(join(trialDir, "config.json"), JSON.stringify({ job_id: jobId2 }));
        writeFileSync(
          join(trialDir, "result.json"),
          JSON.stringify({
            id: "e5f342af-b755-4208-9ebf-9f8dee679189",
            task_name: "oracle-task",
            trial_name: "different-trial-name",
            trial_uri: "file://" + trialDir,
            task_id: { path: "oracle-task" },
            task_checksum: authenticOracleChecksum,
            config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: jobId2 },
            agent_info: { name: "oracle", version: "1.0.0" },
            finished_at: new Date().toISOString(),
            verifier_result: { rewards: { reward: 1.0 } },
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapterMismatchedTrialName.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /Trial name mismatch/);
        return true;
      },
    );

    // 3. Contradictory manifest jobs_dir
    const mismatchManifestPath = join(tempDir, "mismatch-config.yaml");
    writeFileSync(
      mismatchManifestPath,
      "job_name: oracle-job\njobs_dir: /some/contradictory/jobs_dir\nagents:\n  - name: oracle\ntasks:\n  - path: /tmp/task\n",
    );
    const adapterMismatchJobsDir = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        return createDummyResult(0);
      }),
    });
    await assert.rejects(
      () =>
        adapterMismatchJobsDir.run({
          jobConfigPath: mismatchManifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Manifest jobs_dir .* contradicts request.jobsRoot/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION IMPOSSIBLE_CROSS_LINKS_REJECTED - rejects foreign job_name, task/agent contradictions, and external URI", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-impossible-links-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeFileSync(
      manifestPath,
      "job_name: oracle-job\nagents:\n  - name: oracle\ntasks:\n  - path: /tmp/task\n",
    );

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });

    // 1. Foreign job_name in declared trials
    const adapterForeignJob = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: "a1111111-1111-4111-a111-111111111111",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "different-job", trial_name: "trial-1" }],
          }),
        );
        writeFileSync(join(trialDir, "config.json"), JSON.stringify({ job_id: "a1111111-1111-4111-a111-111111111111" }));
        writeFileSync(
          join(trialDir, "result.json"),
          JSON.stringify({
            id: "e5f342af-b755-4208-9ebf-9f8dee679189",
            task_name: "oracle-task",
            trial_name: "trial-1",
            trial_uri: "file://" + trialDir,
            task_id: { path: "oracle-task" },
            task_checksum: authenticOracleChecksum,
            config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: "a1111111-1111-4111-a111-111111111111" },
            agent_info: { name: "oracle", version: "1.0.0" },
            finished_at: new Date().toISOString(),
            verifier_result: { rewards: { reward: 1.0 } },
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapterForeignJob.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /foreign job_name/);
        return true;
      },
    );

    // 2. External trial_uri (e.g. https://attacker.example/jobs/trial-1)
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(trialDir, { recursive: true });
    const adapterExternalUri = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: "a2222222-2222-4222-a222-222222222222",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
          }),
        );
        writeFileSync(join(trialDir, "config.json"), JSON.stringify({ job_id: "a2222222-2222-4222-a222-222222222222" }));
        writeFileSync(
          join(trialDir, "result.json"),
          JSON.stringify({
            id: "e5f342af-b755-4208-9ebf-9f8dee679189",
            task_name: "oracle-task",
            trial_name: "trial-1",
            trial_uri: "https://attacker.example/jobs/trial-1",
            task_id: { path: "oracle-task" },
            task_checksum: authenticOracleChecksum,
            config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: "a2222222-2222-4222-a222-222222222222" },
            agent_info: { name: "oracle", version: "1.0.0" },
            finished_at: new Date().toISOString(),
            verifier_result: { rewards: { reward: 1.0 } },
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapterExternalUri.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /External trial_uri .* rejected/);
        return true;
      },
    );

    // 3. Contradictory agent_info.name not in manifest
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(trialDir, { recursive: true });
    const adapterContradictoryAgent = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: "a3333333-3333-4333-a333-333333333333",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
          }),
        );
        writeFileSync(join(trialDir, "config.json"), JSON.stringify({ job_id: "a3333333-3333-4333-a333-333333333333" }));
        writeFileSync(
          join(trialDir, "result.json"),
          JSON.stringify({
            id: "e5f342af-b755-4208-9ebf-9f8dee679189",
            task_name: "oracle-task",
            trial_name: "trial-1",
            trial_uri: "file://" + trialDir,
            task_id: { path: "oracle-task" },
            task_checksum: authenticOracleChecksum,
            config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: "a3333333-3333-4333-a333-333333333333" },
            agent_info: { name: "forged-unauthorized-agent", version: "1.0.0" },
            finished_at: new Date().toISOString(),
            verifier_result: { rewards: { reward: 1.0 } },
          }),
        );
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapterContradictoryAgent.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /Trial agent "forged-unauthorized-agent" contradicts manifest agents/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("run: MUTATION TOUCH_ONLY_TRIAL_STALE_REJECTED - rejects pre-existing trial artifact when merely touched", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-trial-touch-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeOracleManifest(manifestPath);

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const preExistingJobId = "a1111111-1111-4111-a111-111111111111";
    const freshJobId = "a2222222-2222-4222-a222-222222222222";

    // Write pre-existing trial result before execution
    const preExistingTrialJson = JSON.stringify({
      id: "e5f342af-b755-4208-9ebf-9f8dee679189",
      task_name: "oracle-task",
      trial_name: "trial-1",
      trial_uri: "file://" + trialDir,
      task_id: { path: "oracle-task" },
      task_checksum: authenticOracleChecksum,
      config: { task: { path: "oracle-task" }, agent: { name: "oracle" }, job_id: preExistingJobId },
      agent_info: { name: "oracle", version: "1.0.0" },
      finished_at: new Date().toISOString(),
      verifier_result: { rewards: { reward: 1.0 } },
    });
    writeFileSync(join(trialDir, "result.json"), preExistingTrialJson);
    writeFileSync(join(trialDir, "config.json"), JSON.stringify({ job_id: freshJobId }));

    // Executor generates fresh job result.json, but merely touches trial/result.json without changing bytes
    const adapter = new HarborAdapter({
      executor: new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: freshJobId,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 1,
            stats: { n_trials: 1, n_errors: 0 },
            trials: [{ job_name: "oracle-job", trial_name: "trial-1" }],
          }),
        );
        // Touch mtime of trial result.json without changing content
        const now = new Date();
        utimesSync(join(trialDir, "result.json"), now, now);
        return createDummyResult(0);
      }),
    });

    await assert.rejects(
      () =>
        adapter.run({
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /Stale trial artifact detected .* content is unchanged from pre-execution state/);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vertical slice: MUTATION EVALUATED_TRIAL_ZERO_REWARD_PRESERVED - preserves task failure with reward 0 without throwing", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-zero-reward-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "a4444444-4444-4444-a444-444444444444";

    const session = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 0.0, // Explicit evaluated reward = 0
          arm: "A0_baseline",
        });
        return createDummyResult(0);
      }),
    );

    result = await executeVerticalSlice({
      trialId: "trial-zero-reward",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: {
        taskId: "task-1",
        taskName: "oracle-task",
        taskChecksum: authenticOracleChecksum,
        benchmarkVersion: R4_BENCHMARK_VERSION,
      },
      agent: {
        agentName: "oracle",
        modelName: "oracle-v1",
        promptContent: "You are an autonomous AI coding agent solving oracle-task.",
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      harborSession: session,
    });

    // The trial must NOT be dropped or rejected: evaluated task failure is preserved
    assert.equal(result.trial.verifier?.passed, false);
    assert.equal(result.trial.verifier?.reward, 0.0);
    assert.equal(result.trial.metrics.falseCompletionTerminal, true);
    assert.equal(result.trial.failureClassification, null);
    assert.equal(result.trial.harbor?.trialId, "e5f342af-b755-4208-9ebf-9f8dee679189");

    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.verifier?.passed, false);
    assert.equal(records[0]?.verifier?.reward, 0.0);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("vertical slice: MUTATION ARTIFACT_BOUND_HASHES_CHANGE_DETECTED - prompt and workspace modifications strictly alter hashes", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-hash-binding-"));
  let resA: VerticalSliceResult | undefined;
  let resB: VerticalSliceResult | undefined;
  try {
    const wsA = join(tempDir, "workspace-a");
    const wsB = join(tempDir, "workspace-b");
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    writeFileSync(join(wsA, "solution.txt"), "Version A of solution");
    writeFileSync(join(wsB, "solution.txt"), "Version B of solution - completely different bytes");

    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });

    // R5: native trial content differs per run (distinct UUIDs + distinct
    // executed workspace bytes); prompt and container differ per run.
    const createMockRunner = (jobUuid: string, trialUuid: string, solutionBytes: string, containerDigest: string) =>
      newBridgeSession(
        new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
          await simulateBridgeRun({
            jobDir,
            trialDir,
            jobId: jobUuid,
            trialUuid,
            reward: 1.0,
            arm: "A0_baseline",
            snapshotFiles: { "solution.txt": solutionBytes },
            containerDigest,
          });
          return createDummyResult(0);
        }),
      );

    // Run A
    writeOracleManifest(
      manifestPath,
      "A0_baseline",
      "sha256:ba5e000000000000000000000000000000000000000000000000000000000001",
    );
    resA = await executeVerticalSlice({
      trialId: "trial-hash-a",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "Prompt version A" },
      expectedContainerDigest: "sha256:ba5e000000000000000000000000000000000000000000000000000000000001",
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath: join(tempDir, "trials-a.ndjson"),
      harborSession: createMockRunner(
        "a5555555-5555-4555-a555-555555555555",
        "e5f342af-b755-4208-9ebf-9f8dee679189",
        "Version A of solution",
        "sha256:ba5e000000000000000000000000000000000000000000000000000000000001",
      ),
    });

    // Run B (modified prompt, modified workspace, modified container)
    rmSync(jobDir, { recursive: true, force: true });
    mkdirSync(trialDir, { recursive: true });
    writeOracleManifest(
      manifestPath,
      "A0_baseline",
      "sha256:ba5e000000000000000000000000000000000000000000000000000000000002",
    );
    resB = await executeVerticalSlice({
      trialId: "trial-hash-b",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "Prompt version B - altered bytes" },
      expectedContainerDigest: "sha256:ba5e000000000000000000000000000000000000000000000000000000000002",
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath: join(tempDir, "trials-b.ndjson"),
      harborSession: createMockRunner(
        "b5555555-5555-4555-b555-555555555555",
        "f5f342af-b755-4208-9ebf-9f8dee679180",
        "Version B of solution - completely different bytes",
        "sha256:ba5e000000000000000000000000000000000000000000000000000000000002",
      ),
    });

    // Hashes must be strictly distinct
    assert.notEqual(resA.trial.reproducibility.promptHash, resB.trial.reproducibility.promptHash);
    assert.notEqual(resA.trial.reproducibility.containerDigest, resB.trial.reproducibility.containerDigest);
    assert.notEqual(resA.trial.execution.claims[0]?.workspaceHash, resB.trial.execution.claims[0]?.workspaceHash);
    assert.notEqual(resA.trial.execution.claims[0]?.claimSnapshotId, resB.trial.execution.claims[0]?.claimSnapshotId);

    // Rejection when prompt evidence is absent (synthetic fallbacks forbidden)
    writeOracleManifest(manifestPath);
    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "trial-hash-no-prompt",
          arm: "A0_baseline",
      ...r4Provenance("r4"),
          task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
          agent: { agentName: "oracle", modelName: "oracle-v1" },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: {
            jobConfigPath: manifestPath,
            jobsRoot: tempDir,
            expectedJobName: "oracle-job",
            timeoutMs: 5000,
            successCriterion: "reward >= 1.0",
            expectedTaskChecksum: authenticOracleChecksum,
          },
          ndjsonPath: join(tempDir, "trials-fail.ndjson"),
          harborSession: newBridgeSession(
            new MockCommandExecutor(async () => createDummyResult(0)),
          ),
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "CONFIG_INVALID");
        assert.match(err.message, /Missing prompt evidence/);
        return true;
      },
    );
  } finally {
    cleanupTestDir(tempDir, resA);
    try { if (resB?.snapshotDirectory) makeWritableRecursive(resB.snapshotDirectory); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// 6. Vertical Slice Core ↔ Runtime Integration Tests
// ---------------------------------------------------------------------------

test("vertical slice: A0 baseline does NOT call CompletionGate, executes Harbor, and records BenchmarkTrial in NDJsonStore", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-slice-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";

    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A0_baseline",
        });
        return createDummyResult(0);
      }),
    );

    let gateCalled = false;
    const mockGate = {
      evaluate: async () => {
        gateCalled = true;
        throw new Error("CompletionGate must NEVER be called for A0_baseline!");
      },
    };

    result = await executeVerticalSlice({
      trialId: "trial-vertical-1",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: {
        taskId: "task-1",
        taskName: "oracle-task",
        taskChecksum: authenticOracleChecksum,
        benchmarkVersion: R4_BENCHMARK_VERSION,
      },
      agent: {
        agentName: "oracle",
        modelName: "oracle-v1",
        promptContent: "You are an autonomous AI coding agent solving oracle-task.",
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      completionGate: mockGate,
      harborSession: adapter,
    });

    assert.equal(gateCalled, false, "CompletionGate was called for arm A0_baseline!");
    assert.equal(result.gateResult, undefined);
    assert.equal(result.trial.trialId, "trial-vertical-1");
    assert.equal(result.trial.arm, "A0_baseline");
    // R8 item 4: A0 logs no gate event at all — the gate was never requested.
    assert.deepEqual(result.eventLog.map((e) => e.event), [
      "agent_started",
      "native_completion_claim",
      "snapshot_sealed",
      "verifier_finished",
    ]);
    assert.equal(result.trial.execution.claims[0]?.gateTriggered, null);
    assert.equal(result.trial.execution.claims[0]?.gateVerdict, "NOT_EVALUATED");
    assert.equal(result.trial.execution.claims[0]?.snapshotVerification.status, null);
    assert.equal(result.trial.execution.claims[0]?.snapshotVerification.reward, null);
    assert.equal(result.trial.verifier?.reward, 1.0);
    assert.equal(result.trial.failureClassification, null);

    // Verify stored trial in NDJSON
    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.trialId, "trial-vertical-1");
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("vertical slice: A2 blocking arm runs the single Harbor session, then blocks on gate FAIL with trial_blocked", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-slice-blocked-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A2_blocking");

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "b1111111-1111-4111-b111-111111111111";

    // R5 single-run: Harbor executes FIRST (exactly once); the gate then
    // evaluates the native trial snapshot and blocks it.
    let harborRunCount = 0;
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        harborRunCount += 1;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A2_blocking",
          patchResult: (payload) => {
            payload["agent_result"] = {
              n_input_tokens: 1234,
              n_output_tokens: 234,
              cost_usd: 0.25,
            };
          },
        });
        return createDummyResult(0);
      }),
    );

    // Mock completion gate returning FAIL
    const failingGate = {
      evaluate: async () => ({
        gateId: "G1_SECURITY",
        verdict: "FAIL" as const,
        evaluatedAt: new Date().toISOString(),
        checks: [
          {
            id: "policy-check",
            verdict: "FAIL" as const,
            evidence: ["policy violation detected"],
            message: "Disallowed network access",
          },
        ],
      }),
    };

    result = await executeVerticalSlice({
      trialId: "trial-vertical-blocked-1",
      arm: "A2_blocking",
      ...r4Provenance("r4"),
      task: {
        taskId: "task-1",
        taskName: "oracle-task",
        taskChecksum: authenticOracleChecksum,
        benchmarkVersion: R4_BENCHMARK_VERSION,
      },
      agent: {
        agentName: "oracle",
        modelName: "oracle-v1",
        promptContent: "You are an autonomous AI coding agent solving oracle-task.",
      },
      gateInput: {
        gateId: "G1_SECURITY",
        declaredChecks: [{ id: "policy-check", description: "check", required: true }],
        evidenceRoot: tempDir,
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      completionGate: failingGate,
      harborSession: adapter,
    });

    assert.equal(harborRunCount, 1, "Single-run session must invoke Harbor exactly once, before the gate!");
    assert.equal(result.gateResult?.verdict, "FAIL");
    assert.equal(result.trial.verifier, null);
    assert.equal(result.trial.failureClassification, "GOVERNANCE_FAILURE");
    assert.equal(result.trial.execution.claims[0]?.gateVerdict, "BLOCK");
    assert.deepEqual(result.trial.execution.claims[0]?.failureReasons, [
      "Disallowed network access\npolicy violation detected",
    ], "A3-facing diagnostics must preserve sanitized evidence, not only a generic message");
    assert.equal(result.trial.execution.claims[0]?.snapshotVerification.status, null);
    assert.equal(result.trial.execution.claims[0]?.snapshotVerification.reward, null);
    assert.equal(result.trial.metrics.falseCompletionTerminal, null, "Terminal false completion must be null when verifier is null!");
    assert.equal(result.trial.metrics.falseCompletionInitial, null, "Initial false completion must be null when snapshot verification is unverified!");
    assert.equal(result.trial.metrics.falseCompletionIntercepted, null);
    assert.equal(result.trial.execution.finalStopReason, "gate_blocked_exhausted");
    assert.deepEqual(
      { inputTokens: result.trial.usage.inputTokens, outputTokens: result.trial.usage.outputTokens, costUsd: result.trial.usage.costUsd },
      { inputTokens: 1234, outputTokens: 234, costUsd: 0.25 },
      "blocked/recovery-exhausted trials must preserve observed usage instead of erasing cost",
    );
    // No fictitious verifier_finished: blocked trials end with trial_blocked.
    assert.deepEqual(result.eventLog.map((e) => e.event), [
      "agent_started",
      "native_completion_claim",
      "snapshot_sealed",
      "gate_evaluated",
      "trial_blocked",
    ]);
    // Correlation persists even for blocked trials (same native execution).
    assert.equal(result.trial.harbor?.jobId, jobId);
    assert.equal(result.trial.harbor?.trialName, "trial-1");
    assert.equal(result.trial.execution.runtimeRunId, "e5f342af-b755-4208-9ebf-9f8dee679189");
    assert.equal(result.trial.execution.workspaceId, "trial-1");

    // Verify stored trial in NDJSON
    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.trialId, "trial-vertical-blocked-1");
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("vertical slice: MUTATION EMPTY_RUNNER_REJECTED - zero-trial session throws but persists one failure record", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-empty-runner-"));
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);

    // R5: a session declaring zero trials goes through the real adapter path
    // (mandatory preflight + run) and fails closed on cardinality.
    const jobDir = join(tempDir, "oracle-job");
    mkdirSync(jobDir, { recursive: true });
    const emptyAdapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: "a0000000-0000-4000-a000-000000000000",
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            n_total_trials: 0,
            stats: { n_trials: 0, n_errors: 0 },
          }),
        );
        return createDummyResult(0);
      }),
    );

    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "trial-empty-runner",
          arm: "A0_baseline",
      ...r4Provenance("r4"),
          task: {
            taskId: "task-1",
            taskName: "oracle-task",
            taskChecksum: authenticOracleChecksum,
            benchmarkVersion: R4_BENCHMARK_VERSION,
          },
          agent: {
            agentName: "oracle",
            modelName: "oracle-v1",
            promptContent: "You are an autonomous AI coding agent solving oracle-task.",
          },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: {
            jobConfigPath: manifestPath,
            jobsRoot: tempDir,
            expectedJobName: "oracle-job",
            timeoutMs: 5000,
            successCriterion: "reward >= 1.0",
            expectedTaskChecksum: authenticOracleChecksum,
          },
          ndjsonPath,
          harborSession: emptyAdapter,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /Zero-trial job rejected/);
        return true;
      },
    );

    // R5: failed attempts are recorded, never silently dropped.
    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.failureClassification, "EXOGENOUS_INFRASTRUCTURE_FAILURE");
    assert.equal(records[0]?.verifier, null);
    assert.deepEqual(records[0]?.execution.claims, []);
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("vertical slice: MUTATION REWARD_0_25_PRESERVED - preserves actual reward 0.25 without converting to 1.0", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-reward-025-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";

    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 0.25,
          arm: "A0_baseline",
        });
        return createDummyResult(0);
      }),
    );

    result = await executeVerticalSlice({
      trialId: "trial-reward-025",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: {
        taskId: "task-1",
        taskName: "oracle-task",
        taskChecksum: authenticOracleChecksum,
        benchmarkVersion: R4_BENCHMARK_VERSION,
      },
      agent: {
        agentName: "oracle",
        modelName: "oracle-v1",
        promptContent: "You are an autonomous AI coding agent solving oracle-task.",
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 0.2",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      harborSession: adapter,
    });

    assert.equal(result.trial.verifier?.passed, true);
    assert.equal(result.trial.verifier?.reward, 0.25, "Reward must be exactly 0.25, never inflated to 1.0!");

    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.verifier?.reward, 0.25);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("vertical slice: A1 observing arm evaluates CompletionGate without blocking", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-slice-a1-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A1_observing");

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";

    let harborRunCalled = false;
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        harborRunCalled = true;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A1_observing",
        });
        return createDummyResult(0);
      }),
    );

    const failingGate = {
      evaluate: async () => ({
        gateId: "G0_LINT",
        verdict: "FAIL" as const,
        evaluatedAt: new Date().toISOString(),
        checks: [{
          id: "lint",
          verdict: "FAIL" as const,
          evidence: ["stderr: deterministic lint failure", "exitCode: 1"],
          message: "Lint error",
        }],
      }),
    };

    result = await executeVerticalSlice({
      trialId: "trial-a1-observing",
      arm: "A1_observing",
      ...r4Provenance("r4"),
      task: {
        taskId: "task-1",
        taskName: "oracle-task",
        taskChecksum: authenticOracleChecksum,
        benchmarkVersion: R4_BENCHMARK_VERSION,
      },
      agent: {
        agentName: "oracle",
        modelName: "oracle-v1",
        promptContent: "You are an autonomous AI coding agent solving oracle-task.",
      },
      gateInput: {
        gateId: "G0_LINT",
        declaredChecks: [{ id: "lint", description: "check", required: true }],
        evidenceRoot: tempDir,
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      completionGate: failingGate,
      harborSession: adapter,
    });

    assert.equal(harborRunCalled, true, "A1 observing arm must proceed to run Harbor regardless of gate verdict!");
    assert.equal(result.gateResult?.verdict, "FAIL");
    assert.deepEqual(result.gateResult?.checks, [{
      id: "lint",
      verdict: "FAIL",
      evidence: ["stderr: deterministic lint failure", "exitCode: 1"],
      message: "Lint error",
    }], "the vertical-slice result must preserve the complete gate transcript");
    assert.equal(result.trial.execution.claims[0]?.gateVerdict, "BLOCK");
    assert.deepEqual(result.trial.execution.claims[0]?.failureReasons, [
      "Lint error\nstderr: deterministic lint failure\nexitCode: 1",
    ]);
    assert.equal(result.trial.verifier?.passed, true);
    assert.equal(result.trial.execution.finalStopReason, "agent_declared_done");
    // R6 item 6: an observed BLOCK never deletes the verifier that ran.
    assert.ok(result.trial.verifier !== null, "A1 observed-BLOCK must keep the verifier evidence.");
    const persistedGate = JSON.parse(
      readFileSync(join(trialDir, "gate-verdict.json"), "utf8"),
    ) as { checks?: unknown };
    assert.deepEqual(persistedGate.checks, [{
      id: "lint",
      verdict: "FAIL",
      evidence: ["stderr: deterministic lint failure", "exitCode: 1"],
      message: "Lint error",
    }], "gate-verdict.json must preserve the complete sanitized check transcript");
    assert.deepEqual(result.eventLog.map((e) => e.event), [
      "agent_started",
      "native_completion_claim",
      "snapshot_sealed",
      "gate_evaluated",
      "verifier_finished",
    ]);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("vertical slice: A3 recovering arm reaches the runtime session (protocol is no longer rejected at configuration)", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-a3-"));
  try {
    const manifestPath = join(tempDir, "config.yaml");
    writeOracleManifest(manifestPath);

    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "trial-a3",
          arm: "A3_recovering",
      ...r4Provenance("r4"),
          task: {
            taskId: "task-1",
            taskName: "oracle-task",
            taskChecksum: authenticOracleChecksum,
            benchmarkVersion: R4_BENCHMARK_VERSION,
          },
          agent: {
            agentName: "oracle",
            modelName: "oracle-v1",
            promptContent: "You are an autonomous AI coding agent solving oracle-task.",
          },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: {
            jobConfigPath: manifestPath,
            jobsRoot: tempDir,
            expectedJobName: "oracle-job",
            timeoutMs: 5000,
            successCriterion: "reward >= 1.0",
            expectedTaskChecksum: authenticOracleChecksum,
          },
          ndjsonPath: join(tempDir, "trials.ndjson"),
          harborSession: newBridgeSession(
            new MockCommandExecutor(async () => createDummyResult(0)),
          ),
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.notEqual(err.message.includes("A3_recovering protocol is not yet implemented"), true);
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("vertical slice: MUTATION CAUSAL_ORDER_AND_IMMUTABLE_SNAPSHOT - creates disk snapshot before gate and verifies causal lifecycle", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-causal-"));
  let result: VerticalSliceResult | undefined;
  try {
    const wsDir = join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "app.py"), "print('hello world')");

    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A1_observing");

    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "a6666666-6666-4666-a666-666666666666";

    let gateEvidenceRoot = "";

    const trackingGate = {
      evaluate: async (input: GateEvaluationInput) => {
        gateEvidenceRoot = input.evidenceRoot;
        assert.ok(existsSync(join(input.evidenceRoot, "app.py")));
        return {
          gateId: "G0_LINT",
          verdict: "PASS" as const,
          evaluatedAt: new Date().toISOString(),
          checks: [{ id: "lint", verdict: "PASS" as const, evidence: [], message: "ok" }],
        };
      },
    };

    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A1_observing",
          snapshotFiles: { "app.py": "print('hello world')" },
        });
        return createDummyResult(0);
      }),
    );

    result = await executeVerticalSlice({
      trialId: "trial-causal-test",
      arm: "A1_observing",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "Solve task" },
      gateInput: {
        gateId: "G0_LINT",
        declaredChecks: [{ id: "lint", description: "check", required: true }],
        evidenceRoot: wsDir,
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      completionGate: trackingGate,
      harborSession: adapter,
    });

    assert.ok(result.snapshotDirectory, "Snapshot directory must be returned");
    assert.ok(existsSync(result.snapshotDirectory!), "Snapshot directory must exist on disk");
    assert.ok(existsSync(join(result.snapshotDirectory!, "app.py")), "Snapshot directory must contain copied workspace files");
    // R6: the gate evaluates the bridge-exported LIVE snapshot during the
    // session (pre-verifier); the slice seals those same bytes afterwards.
    // The seal/gate hash equality is enforced inside the slice (TOCTOU guard).
    assert.equal(gateEvidenceRoot, join(trialDir, "workspace-snapshot"), "Gate must evaluate the bridge-exported pre-verifier snapshot");
    // Claim timestamp is the bridge-observed clean return (valid ISO, recent).
    const causalClaimTs = new Date(result.trial.execution.claims[0]?.timestamp ?? 0).getTime();
    assert.ok(!Number.isNaN(causalClaimTs) && Date.now() - causalClaimTs < 120_000);
    const order = result.eventLog.map((e) => e.event);
    assert.deepEqual(order, [
      "agent_started",
      "native_completion_claim",
      "snapshot_sealed",
      "gate_evaluated",
      "verifier_finished",
    ]);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

// ---------------------------------------------------------------------------
// 6B. ZB2.2-R4 Red Team mutations (Codex review e410a47)
// ---------------------------------------------------------------------------

test("R6: MUTATION TWO_UNCORRELATED_EXECUTIONS - single Harbor invocation per slice, native correlation persisted", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-single-run-"));
  let result: VerticalSliceResult | undefined;
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "a1234567-1234-4123-a123-123456789012";
    const trialUuid = "b1234567-1234-4123-b123-123456789012";
    // Count Harbor invocations: exactly ONE `harbor run` per slice. There is
    // no agentRunner anymore — a second agent execution is unrepresentable.
    let harborRunCount = 0;
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        harborRunCount += 1;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: trialUuid,
          reward: 1.0,
          arm: "A0_baseline",
        });
        return createDummyResult(0);
      }),
    );

    result = await executeVerticalSlice({
      trialId: "trial-single-run",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "Solve oracle-task natively." },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath: join(tempDir, "trials.ndjson"),
      harborSession: adapter,
    });

    assert.equal(harborRunCount, 1, "Two uncorrelated executions are forbidden: exactly one Harbor invocation.");
    // Native correlation persisted (not just checked non-empty).
    assert.equal(result.trial.harbor?.jobId, jobId);
    assert.equal(result.trial.harbor?.trialId, trialUuid);
    assert.equal(result.trial.harbor?.trialName, "trial-1");
    assert.equal(result.trial.execution.runtimeRunId, trialUuid);
    assert.equal(result.trial.execution.workspaceId, "trial-1");
    // Claim timestamp is the bridge-observed clean return (valid ISO, recent).
    const claimTs = new Date(result.trial.execution.claims[0]?.timestamp ?? 0).getTime();
    assert.ok(!Number.isNaN(claimTs) && Date.now() - claimTs < 120_000, "Claim timestamp must be a recent native observation.");
    // Live container identity persisted (not manifest text).
    assert.ok((result.trial.harbor?.containerId ?? "").length > 0);
    assert.equal(result.trial.harbor?.containerDigest, R4_TEST_DIGEST);
    // Provenance refs are populated (contract is used, not decorative).
    assert.equal(result.trial.provenance.prompt.kind, "prompt-bytes");
    assert.equal(result.trial.provenance.container.kind, "container-manifest");
    assert.equal(result.trial.provenance.workspaceSnapshot.kind, "workspace-snapshot");
    assert.equal(result.trial.provenance.workspaceSnapshot.sha256, result.trial.execution.claims[0]?.claimSnapshotId);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: MUTATION WRITABLE_SNAPSHOT_ACCEPTED - gate writes fail closed against the read-only gate window", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-writable-snap-"));
  let result: VerticalSliceResult | undefined;
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A1_observing");
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "b6666666-6666-4666-b666-666666666666";
    const mutatingGate = {
      evaluate: async (input: GateEvaluationInput) => {
        writeFileSync(join(input.evidenceRoot, "gate-mutation.txt"), "mutated");
        return {
          gateId: "G1",
          verdict: "PASS" as const,
          evaluatedAt: new Date().toISOString(),
          checks: [{ id: "c", verdict: "PASS" as const, evidence: [], message: "ok" }],
        };
      },
    };
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A1_observing",
        });
        return createDummyResult(0);
      }),
    );
    // R6: the session holds the snapshot read-only while the gate evaluates,
    // so the write fails (EACCES) and the session records a fail-closed BLOCK
    // verdict instead of letting the gate mutate evidence. A1 observes.
    result = await executeVerticalSlice({
      trialId: "trial-writable-snap",
      arm: "A1_observing",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
      gateInput: { gateId: "G1", declaredChecks: [{ id: "c", description: "c", required: true }], evidenceRoot: tempDir },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath: join(tempDir, "trials.ndjson"),
      completionGate: mutatingGate,
      harborSession: adapter,
    });
    assert.equal(result.trial.execution.claims[0]?.gateVerdict, "BLOCK");
    assert.ok(
      (result.trial.execution.claims[0]?.failureReasons ?? []).some((m) => /Gate decider failed/i.test(m)),
      "BLOCK must cite the failed gate write",
    );
    // The mutation never reached the sealed evidence.
    assert.equal(existsSync(join(result.snapshotDirectory!, "gate-mutation.txt")), false);
    assert.ok(result.trial.verifier !== null, "A1 observes: verifier evidence kept.");
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: MUTATION TWO_TRIALS_ONE_RECORD - N trials produce N NDJSON records", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-two-trials-"));
  let result: VerticalSliceResult | undefined;
  try {
    const wsDir = join(tempDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(join(wsDir, "app.py"), "print(1)");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir1 = join(jobDir, "trial-1");
    const trialDir2 = join(jobDir, "trial-2");
    mkdirSync(trialDir1, { recursive: true });
    mkdirSync(trialDir2, { recursive: true });
    const jobId = "c7777777-7777-4777-a777-777777777777";
    const session = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        const now2 = (): string => new Date().toISOString();
        writeFileSync(
          join(jobDir, "result.json"),
          JSON.stringify({
            id: jobId,
            started_at: now2(),
            finished_at: now2(),
            n_total_trials: 2,
            stats: { n_trials: 2, n_errors: 0 },
          }),
        );
        writeFileSync(
          join(jobDir, "harbor-version.json"),
          JSON.stringify({ version: "0.1.2", source: "importlib" }),
        );
        for (const [td, tname, tid, reward] of [
          [trialDir1, "trial-1", "a1111111-1111-4111-a111-111111111111", 1.0],
          [trialDir2, "trial-2", "a2222222-2222-4222-a222-222222222222", 0.0],
        ] as const) {
          await simulateBridgeTrial({
            trialDir: td,
            trialName: tname,
            jobId,
            trialUuid: tid,
            reward,
            arm: "A0_baseline",
            snapshotFiles: { "solution.txt": `solution bytes for ${tname}` },
          });
        }
        return createDummyResult(0);
      }),
    );
    const ndjsonPath = join(tempDir, "trials.ndjson");
    result = await executeVerticalSlice({
      trialId: "trial-two",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      harborSession: session,
    });
    assert.equal(result.trials.length, 2);
    // R5: each trial owns its execution, claim, snapshot and native IDs —
    // no duplicated single claim across N records.
    assert.equal(result.trials[0]?.execution.runtimeRunId, "a1111111-1111-4111-a111-111111111111");
    assert.equal(result.trials[1]?.execution.runtimeRunId, "a2222222-2222-4222-a222-222222222222");
    assert.equal(result.trials[0]?.execution.workspaceId, "trial-1");
    assert.equal(result.trials[1]?.execution.workspaceId, "trial-2");
    assert.notEqual(
      result.trials[0]?.execution.claims[0]?.claimSnapshotId,
      result.trials[1]?.execution.claims[0]?.claimSnapshotId,
    );
    assert.equal(result.trials[0]?.harbor?.trialId, "a1111111-1111-4111-a111-111111111111");
    assert.equal(result.trials[1]?.harbor?.trialId, "a2222222-2222-4222-a222-222222222222");
    assert.equal(result.trials[0]?.verifier?.reward, 1.0);
    assert.equal(result.trials[1]?.verifier?.reward, 0.0);
    assert.equal(result.eventLogs.length, 2);
    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 2);
    assert.notEqual(records[0]?.trialId, records[1]?.trialId);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: MUTATION UNBOUND_PROVENANCE_ACCEPTED - digest drift and missing provenance rejected", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-unbound-"));
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A0_baseline", R4_TEST_DIGEST);
    const baseTask = { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION };
    const baseReq = {
      jobConfigPath: manifestPath,
      jobsRoot: tempDir,
      expectedJobName: "oracle-job",
      timeoutMs: 5000,
      successCriterion: "reward >= 1.0",
      expectedTaskChecksum: authenticOracleChecksum,
    };
    // Manifest digest X, live container resolves Y: the bridge sidecar carries
    // the drifted digest; the slice quarantines (recorded, never trusted).
    const driftJobDir = join(tempDir, "oracle-job");
    const driftTrialDir = join(driftJobDir, "trial-1");
    mkdirSync(driftTrialDir, { recursive: true });
    const driftAdapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir: driftJobDir,
          trialDir: driftTrialDir,
          jobId: "a9999999-9999-4999-a999-999999999999",
          trialUuid: "b9999999-9999-4999-b999-999999999999",
          reward: 1.0,
          arm: "A0_baseline",
          containerDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
        return createDummyResult(0);
      }),
    );
    // Manifest digest X, runtime resolves Y: the manifest cannot authenticate
    // itself — drift quarantines the trial (recorded, never trusted, never thrown).
    let driftResult: VerticalSliceResult | undefined;
    try {
      driftResult = await executeVerticalSlice({
        trialId: "t-unbound",
        arm: "A0_baseline",
        ...r4Provenance("r4"),
        task: baseTask,
        agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
        expectedContainerDigest: R4_TEST_DIGEST,
        harborRequest: baseReq,
        ndjsonPath: join(tempDir, "a.ndjson"),
        harborSession: driftAdapter,
      });
    } finally {
      // quarantine path returns normally; no temp snapshot leaks
    }
    assert.ok(driftResult);
    assert.equal(driftResult.trials.length, 1);
    assert.equal(driftResult.trials[0]?.failureClassification, "VERIFIER_FAILURE");
    assert.equal(driftResult.trials[0]?.verifier, null);
    assert.deepEqual(driftResult.eventLogs[0]?.map((e) => e.event), [
      "agent_started",
      "native_completion_claim",
      "verifier_skipped",
    ]);
    cleanupTestDir(tempDir, driftResult);
    // Missing experimentId
    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "t-unbound2",
          arm: "A0_baseline",
          ...r4Provenance("r4"),
          experimentId: "",
          task: baseTask,
          agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: baseReq,
          ndjsonPath: join(tempDir, "b.ndjson"),
          harborSession: newBridgeSession(
            new MockCommandExecutor(async () => createDummyResult(0)),
          ),
        }),
      /Missing mandatory provenance/,
    );
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R7: closed launcher factory - counterfeit commands never inherit wheel trust", async () => {
  // Independent authority: the session hashes the wheel FILE and compares it
  // against the lab-owned OFFICIAL_HARBOR_WHEEL_SHA256 constant. No request
  // field can supply a validating hash — the request carries no hash at all.
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-counterfeit-"));
  try {
    const fakeWheel = join(tempDir, "harbor-9.9.9-py3-none-any.whl");
    writeFileSync(fakeWheel, "counterfeit bytes with a self-supplied hash claim");
    const withFakeWheel = (): HarborBridgeSession =>
      newBridgeSession(new MockCommandExecutor(async () => createDummyResult(0)), {
        wheelPath: fakeWheel,
      });
    await assert.rejects(
      () =>
        withFakeWheel().executeSession({
          jobConfigPath: join(tempDir, "missing.yaml"),
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
          arm: "A0_baseline",
          ledgerPath: join(tempDir, "ledger.jsonl"),
          expectedContainerDigest: R4_TEST_DIGEST,
        }),
      /Harbor wheel authentication failed/,
    );
    // The genuine wheel passes the authority check (session then fails on the
    // missing manifest — proving the wheel gate runs FIRST).
    const genuine = newBridgeSession(new MockCommandExecutor(async () => createDummyResult(0)));
    await assert.rejects(
      () =>
        genuine.executeSession({
          jobConfigPath: join(tempDir, "missing.yaml"),
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
          arm: "A0_baseline",
          ledgerPath: join(tempDir, "ledger.jsonl"),
          expectedContainerDigest: R4_TEST_DIGEST,
        }),
      /Job config file not found/,
    );
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R8: arbitrary uvPath stays cli-shape-only; only a resolved uv earns wheel-verified", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-launcher-identity-"));
  let result: VerticalSliceResult | undefined;
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";
    const jobId2 = "bb6ea252-9817-4c82-b432-4f6bf957d3e4";
    const runSliceWith = async (
      launch: { kind: "plain"; executable: string } | { kind: "uv-wheel"; uvPath?: string },
      trialId: string,
      ndjson: string,
      runJobId: string,
      runTrialUuid: string,
    ): Promise<void> => {
      const session = newBridgeSession(
        new MockCommandExecutor(async (req) => {
          const probe = probeRoute(req);
          if (probe) return probe;
          await simulateBridgeRun({
            jobDir,
            trialDir,
            jobId: runJobId,
            trialUuid: runTrialUuid,
            reward: 1.0,
            arm: "A0_baseline",
          });
          return createDummyResult(0);
        }),
        launch.kind === "plain"
          ? { launch }
          : { launch: { kind: "uv-wheel", uvPath: (launch as { uvPath?: string }).uvPath ?? "test-uv" } },
      );
      const res = await executeVerticalSlice({
        trialId,
        arm: "A0_baseline",
        ...r4Provenance("r4"),
        task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
        agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
        expectedContainerDigest: R4_TEST_DIGEST,
        harborRequest: {
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        },
        ndjsonPath: ndjson,
        harborSession: session,
      });
      result = res;
    };
    // A counterfeit plain command never inherits wheel trust, even though the
    // session was constructed with the genuine wheel path.
    await runSliceWith({ kind: "plain", executable: "counterfeit-launcher" }, "trial-plain-1", join(tempDir, "plain.ndjson"), jobId, "e5f342af-b755-4208-9ebf-9f8dee679189");
    assert.equal(result?.trial.distribution, "cli-shape-only");
    // An arbitrary, unresolvable uvPath never inherits wheel trust, even
    // though the session was constructed with the genuine wheel path.
    await runSliceWith({ kind: "uv-wheel", uvPath: "test-uv" }, "trial-uv-1", join(tempDir, "uv.ndjson"), jobId2, "f5f342af-b755-4208-9ebf-9f8dee679180");
    assert.equal(result?.trial.distribution, "cli-shape-only");
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R8: launch authority resolves trust from verified inputs only", async () => {
  const { resolveLaunchAuthority } = await import("../src/sessions/launch-authority.js");
  const { mkdtempSync: mkTmp, writeFileSync: writeTmp } = await import("node:fs");
  const { tmpdir: osTmpdir } = await import("node:os");
  const binDir = mkTmp(join(osTmpdir(), "r8-uv-bin-"));
  try {
    // A caller-selected executable remains unverified even when it is
    // resolvable and literally named `uv`.
    const fakeUv = join(binDir, "uv");
    writeTmp(fakeUv, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeUv, 0o755);
    const verified = resolveLaunchAuthority({
      launch: { kind: "uv-wheel", uvPath: fakeUv },
      env: { PATH: `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env["PATH"] ?? ""}` },
      wheelPath,
      bridgeScriptPath: BRIDGE_SCRIPT,
    });
    assert.equal(verified.identity, "cli-shape-only");
    assert.equal(verified.command, fakeUv);
    assert.ok(verified.prefixArgs.includes(wheelPath));
    assert.ok((verified.bridgeVersion ?? "").length > 0, "bridge version resolved from allowlist");
    // The production form does not accept a caller-selected executable. It
    // resolves the system uv and may then attest the pinned wheel + bridge.
    const systemUv = resolveLaunchAuthority({
      launch: { kind: "uv-wheel" },
      wheelPath,
      bridgeScriptPath: BRIDGE_SCRIPT,
    });
    assert.equal(systemUv.identity, "wheel-verified");
    assert.ok(systemUv.prefixArgs.includes(wheelPath));
    // Unresolvable uv: cli-shape-only, never wheel-verified.
    const unresolved = resolveLaunchAuthority({
      launch: { kind: "uv-wheel", uvPath: "counterfeit-uv-launcher" },
      env: { PATH: binDir },
      wheelPath,
      bridgeScriptPath: BRIDGE_SCRIPT,
    });
    assert.equal(unresolved.identity, "cli-shape-only");
    assert.equal(unresolved.resolvedCommand, null);
    // Resolvable but misnamed binary: still cli-shape-only.
    const notUv = join(binDir, "counterfeit-uv-launcher");
    writeTmp(notUv, "#!/bin/sh\nexit 0\n");
    chmodSync(notUv, 0o755);
    const misnamed = resolveLaunchAuthority({
      launch: { kind: "uv-wheel", uvPath: notUv },
      env: { PATH: binDir },
      wheelPath,
      bridgeScriptPath: BRIDGE_SCRIPT,
    });
    assert.equal(misnamed.identity, "cli-shape-only");
    // Tampered bridge bytes: fail closed, never trusted.
    const tamperedBridge = join(binDir, "shokunin_intercept_agent.py");
    const { readFileSync: readTmp } = await import("node:fs");
    writeTmp(tamperedBridge, readTmp(BRIDGE_SCRIPT, "utf8") + "\n# tampered\n");
    assert.throws(
      () =>
        resolveLaunchAuthority({
          launch: { kind: "uv-wheel", uvPath: fakeUv },
          env: { PATH: binDir },
          wheelPath,
          bridgeScriptPath: tamperedBridge,
        }),
      /Bridge authentication failed/,
    );
    // Tampered wheel bytes: fail closed.
    const tamperedWheel = join(binDir, "harbor-0.1.2-py3-none-any.whl");
    writeTmp(tamperedWheel, "counterfeit wheel bytes");
    assert.throws(
      () =>
        resolveLaunchAuthority({
          launch: { kind: "uv-wheel", uvPath: fakeUv },
          env: { PATH: binDir },
          wheelPath: tamperedWheel,
          bridgeScriptPath: BRIDGE_SCRIPT,
        }),
      /Harbor wheel authentication failed/,
    );
    // Plain launchers never inherit wheel trust.
    const plain = resolveLaunchAuthority({
      launch: { kind: "plain", executable: "counterfeit-launcher" },
      env: { PATH: binDir },
      wheelPath,
      bridgeScriptPath: BRIDGE_SCRIPT,
    });
    assert.equal(plain.identity, "cli-shape-only");
  } finally {
    cleanupTestDir(binDir);
  }
});

test("R9: strict sidecars bind outcomes, governed arms, and complete gate evidence", async () => {
  const { gateRequestSidecarSchema, gateVerdictSidecarSchema, outcomeSidecarSchema } = await import(
    "../src/adapters/sidecars.js"
  );
  const observedAt = new Date().toISOString();
  assert.equal(
    outcomeSidecarSchema.safeParse({
      declaredDone: false,
      reason: "agent_timeout",
      observedAt,
    }).success,
    false,
    "an outcome without an exact trial binding must be rejected",
  );
  assert.equal(
    gateRequestSidecarSchema.safeParse({
      trialName: "trial-1",
      arm: "A0_baseline",
      snapshotDir: "/tmp/not-a-governed-snapshot",
      createdAt: observedAt,
    }).success,
    false,
    "A0 cannot create a gate request",
  );
  const baseVerdict = {
    verdict: "BLOCK",
    failureReasons: ["lint failed"],
    evaluatedAt: observedAt,
    gateId: "G_LINT",
    snapshotHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  assert.equal(
    gateVerdictSidecarSchema.safeParse(baseVerdict).success,
    false,
    "a gate verdict without per-check evidence must be rejected",
  );
  assert.equal(
    gateVerdictSidecarSchema.safeParse({
      ...baseVerdict,
      checks: [{
        id: "lint",
        verdict: "FAIL",
        evidence: ["stderr: lint failed", "exitCode: 1"],
        message: "lint failed",
      }],
    }).success,
    true,
  );
});

test("A3 recovery history enforces ordered retries and terminal outcome", async () => {
  const { recoveryEventsSidecarSchema } = await import("../src/adapters/sidecars.js");
  const at = new Date().toISOString();
  assert.equal(recoveryEventsSidecarSchema.safeParse([
    { attempt: 1, gateVerdict: "BLOCK", action: "retry", at },
    { attempt: 2, gateVerdict: "BLOCK", action: "retry", at },
    { attempt: 3, gateVerdict: "BLOCK", action: "retry", at },
    { attempt: 4, gateVerdict: "PASS", action: "continue", at },
  ]).success, true);
  assert.equal(recoveryEventsSidecarSchema.safeParse([]).success, false);
  assert.equal(recoveryEventsSidecarSchema.safeParse([{ attempt: 1, gateVerdict: "BLOCK", action: "exhausted", at }]).success, false);
  assert.equal(recoveryEventsSidecarSchema.safeParse([{ attempt: 1, gateVerdict: "BLOCK", action: "retry", at }]).success, false);
});

test("R8: gate request must be bound to the native trial workspace snapshot", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-r8-gate-request-"));
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A1_observing");
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    const foreignSnapshotDir = join(tempDir, "foreign-snapshot");
    mkdirSync(trialDir, { recursive: true });
    mkdirSync(foreignSnapshotDir, { recursive: true });
    writeFileSync(join(foreignSnapshotDir, "solution.txt"), "foreign evidence");
    let gateCalls = 0;
    const session = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId: "dc6ea252-9817-4c82-b432-4f6bf957d3e6",
          trialUuid: "d5f342af-b755-4208-9ebf-9f8dee679188",
          reward: 1.0,
          arm: "A1_observing",
          gateRequestOverride: {
            trialName: "trial-1",
            arm: "A1_observing",
            snapshotDir: foreignSnapshotDir,
            createdAt: new Date().toISOString(),
          },
        });
        return createDummyResult(0);
      }),
    );
    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "trial-foreign-gate-snapshot",
          arm: "A1_observing",
          ...r4Provenance("r4"),
          task: {
            taskId: "task-1",
            taskName: "oracle-task",
            taskChecksum: authenticOracleChecksum,
            benchmarkVersion: R4_BENCHMARK_VERSION,
          },
          agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
          gateInput: {
            gateId: "G1_SECURITY",
            declaredChecks: [{ id: "policy-check", description: "check", required: true }],
            evidenceRoot: tempDir,
          },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: {
            jobConfigPath: manifestPath,
            jobsRoot: tempDir,
            expectedJobName: "oracle-job",
            timeoutMs: 5000,
            successCriterion: "reward >= 1.0",
            expectedTaskChecksum: authenticOracleChecksum,
          },
          ndjsonPath: join(tempDir, "trials.ndjson"),
          completionGate: {
            evaluate: async () => {
              gateCalls += 1;
              return {
                gateId: "G1_SECURITY",
                verdict: "PASS" as const,
                evaluatedAt: new Date().toISOString(),
                checks: [],
              };
            },
          },
          harborSession: session,
        }),
      /gate-request\.json is malformed or not exactly bound/,
    );
    assert.equal(gateCalls, 0, "foreign evidence must never reach the completion gate");
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R8: MUTATION DECLARED_DONE_FALSE_ACCEPTED_AS_CLAIM - forged false claim quarantines, never completes", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-r8-false-claim-"));
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const runForgedClaim = async (
      trialId: string,
      ndjson: string,
      runJobId: string,
      extraSidecar: { outcomeExtra?: Record<string, unknown> } = {},
    ): Promise<VerticalSliceResult> => {
      const jobDir = join(tempDir, "oracle-job");
      const trialDir = join(jobDir, "trial-1");
      mkdirSync(trialDir, { recursive: true });
      const session = newBridgeSession(
        new MockCommandExecutor(async (req) => {
          const probe = probeRoute(req);
          if (probe) return probe;
          await simulateBridgeRun({
            jobDir,
            trialDir,
            jobId: runJobId,
            trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
            reward: 1.0,
            arm: "A0_baseline",
            // Forged sidecar: well-formed JSON, valid timestamp, exact trial
            // name — but declaredDone:false. Must never become a completion.
            claimOverride: {
              declaredDone: false,
              observedAt: new Date().toISOString(),
              trialName: "trial-1",
            },
            ...extraSidecar,
          });
          return createDummyResult(0);
        }),
      );
      return executeVerticalSlice({
        trialId,
        arm: "A0_baseline",
        ...r4Provenance("r4"),
        task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
        agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
        expectedContainerDigest: R4_TEST_DIGEST,
        harborRequest: {
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        },
        ndjsonPath: ndjson,
        harborSession: session,
      });
    };
    // Case 1: forged false claim alone.
    const jobId1 = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";
    const r1 = await runForgedClaim("trial-forged-false", join(tempDir, "r1.ndjson"), jobId1);
    assert.equal(r1.trials.length, 1);
    assert.equal(r1.trials[0]?.failureClassification, "VERIFIER_FAILURE");
    assert.deepEqual(r1.trials[0]?.execution.claims, []);
    assert.notEqual(r1.trials[0]?.execution.finalStopReason, "agent_declared_done");
    assert.equal(r1.trials[0]?.metrics.falseCompletionTerminal, null);
    assert.ok(
      !r1.eventLogs[0]?.map((e) => e.event).includes("native_completion_claim"),
      "quarantine must not synthesize a claim event for a forged claim",
    );
    // Case 2: valid claim + coexisting outcome file (mutual exclusivity).
    rmSync(join(tempDir, "oracle-job"), { recursive: true, force: true });
    const jobId2 = "bb6ea252-9817-4c82-b432-4f6bf957d3e4";
    const r2 = await runForgedClaim(
      "trial-forged-both",
      join(tempDir, "r2.ndjson"),
      jobId2,
      {
        outcomeExtra: {
          declaredDone: false,
          reason: "agent_timeout",
          observedAt: new Date().toISOString(),
          trialName: "trial-1",
        },
      },
    );
    assert.equal(r2.trials.length, 1);
    assert.equal(r2.trials[0]?.failureClassification, "VERIFIER_FAILURE");
    assert.deepEqual(r2.trials[0]?.execution.claims, []);
    assert.ok(
      !r2.eventLogs[0]?.map((e) => e.event).includes("native_completion_claim"),
      "coexisting claim+outcome must quarantine without a claim event",
    );
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R6: laboratory wheel allowlist matches the vendored official wheel", async () => {
  const { OFFICIAL_HARBOR_WHEEL_SHA256 } = await import("../src/adapters/harbor-distribution-allowlist.js");
  const { createHash } = await import("node:crypto");
  const observed = createHash("sha256").update(readFileSync(wheelPath)).digest("hex");
  assert.equal(observed, OFFICIAL_HARBOR_WHEEL_SHA256);
});

test("R8: bridge allowlist matches the vendored bridge module bytes", async () => {
  // Programmatic recomputation: hand-transcribed hashes once broke this
  // gate silently (58-char truncation). Never transcribe hashes by hand.
  const { BRIDGE_ALLOWLIST, lookupBridgeVersion } = await import("../src/adapters/bridge-allowlist.js");
  const { createHash: createBridgeHash } = await import("node:crypto");
  const observed = createBridgeHash("sha256").update(readFileSync(BRIDGE_SCRIPT)).digest("hex");
  assert.equal(observed.length, 64);
  assert.equal(lookupBridgeVersion(observed), "1.0.0-r8.3");
  assert.equal(BRIDGE_ALLOWLIST["1.0.0-r8.3"], observed);
  assert.equal(lookupBridgeVersion("0".repeat(64)), null);
});

test("R6: MUTATION PARTIAL_CROSS_LINKS_ACCEPTED - wrong task, missing job_id, foreign, custom and nested URIs rejected", async () => {
  async function runSliceWithTrial(
    buildCase: (trialDir: string, jobId: string) => { uri?: string; patch?: (payload: Record<string, unknown>) => void },
    tkName = "trial-1",
  ): Promise<void> {
    const tempDir = mkdtempSync(join(tmpdir(), "harbor-partial-"));
    try {
      const manifestPath = join(tempDir, "job-config.yaml");
      writeOracleManifest(manifestPath);
      const jobDir = join(tempDir, "oracle-job");
      const trialDir = join(jobDir, tkName);
      mkdirSync(trialDir, { recursive: true });
      const jobId = "b8888888-8888-4888-a888-888888888888";
      const session = newBridgeSession(
        new MockCommandExecutor(async (req) => {
          const probe = probeRoute(req);
          if (probe) return probe;
          const { uri, patch } = buildCase(trialDir, jobId);
          await simulateBridgeRun({
            jobDir,
            trialDir,
            jobId,
            trialUuid: "a9999999-9999-4999-a999-999999999999",
            reward: 1.0,
            arm: "A0_baseline",
            ...(uri !== undefined ? { trialUriOverride: uri } : {}),
            ...(patch !== undefined ? { patchResult: patch } : {}),
          });
          return createDummyResult(0);
        }),
      );
      await executeVerticalSlice({
        trialId: "t-partial",
        arm: "A0_baseline",
        ...r4Provenance("r4"),
        task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
        agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
        expectedContainerDigest: R4_TEST_DIGEST,
        harborRequest: {
          jobConfigPath: manifestPath,
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
        },
        ndjsonPath: join(tempDir, "trials.ndjson"),
        harborSession: session,
      });
    } finally {
      cleanupTestDir(tempDir);
    }
  }
  const setPath = (payload: Record<string, unknown>, path: string, value: unknown): void => {
    (payload["task_id"] as Record<string, unknown>)["path"] = path;
    ((payload["config"] as Record<string, unknown>)["task"] as Record<string, unknown>)["path"] = path;
    payload["task_name"] = value;
  };
  // Wrong task (name + path) with a CONFINED uri: adapter rejects manifest contradiction.
  await assert.rejects(
    () =>
      runSliceWithTrial(() => ({
        patch: (payload) => {
          setPath(payload, "ghost-task", "ghost-task");
        },
      })),
    /contradicts manifest tasks/,
  );
  const missingJobId = (): { uri?: string; patch?: (payload: Record<string, unknown>) => void } => ({
    patch: (payload) => {
      const cfg = payload["config"] as Record<string, unknown>;
      delete cfg["job_id"];
    },
  });
  await assert.rejects(() => runSliceWithTrial(missingJobId), /missing mandatory .*config\.job_id/);
  const foreignUri = (): { uri?: string; patch?: (payload: Record<string, unknown>) => void } => ({
    uri: "file:///etc/foreign-evidence/trial-1",
  });
  await assert.rejects(() => runSliceWithTrial(foreignUri), /escapes expected job|Foreign trial_uri|does not resolve on disk/);
  // R6: custom schemes rejected even with a matching suffix.
  const customUri = (): { uri?: string; patch?: (payload: Record<string, unknown>) => void } => ({
    uri: "custom://foreign-authority/trial-1",
  });
  await assert.rejects(() => runSliceWithTrial(customUri), /Unsupported trial_uri scheme/);
  // R6: a confined homonym directory is NOT the discovered trial directory.
  await assert.rejects(
    () =>
      runSliceWithTrial(
        (trialDir, _jobId) => {
          const foreignDir = join(trialDir, "..", "foreign", "trial-1");
          mkdirSync(foreignDir, { recursive: true });
          return { uri: "file://" + foreignDir };
        },
        "trial-1",
      ),
    /instead of the discovered trial directory/,
  );
});
test("R8: MUTATION A2_SUBSTRING_EXCEPTION_AND_FALSE_MARKER - NotShokuninGateBlocked with PASS marker is rejected, never blocked", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-r8-forged-block-"));
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A2_blocking");
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "cc6ea252-9817-4c82-b432-4f6bf957d3e5";
    const session = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A2_blocking",
          // Forge the exception: substring of the real one, must not match.
          patchResult: (payload) => {
            payload["exception_info"] = {
              exception_type: "NotShokuninGateBlocked",
              exception_message: "forged prevention claim",
              exception_traceback: "",
              occurred_at: new Date().toISOString(),
            };
          },
        });
        // Contradictory marker: declares PASS while the served verdict is BLOCK.
        writeFileSync(
          join(trialDir, "gate-blocked.json"),
          JSON.stringify({ trialName: "trial-1", at: new Date().toISOString(), verdict: { verdict: "PASS" } }),
        );
        return createDummyResult(0);
      }),
    );
    const failingGate = {
      evaluate: async () => ({
        gateId: "G1_SECURITY",
        verdict: "FAIL" as const,
        evaluatedAt: new Date().toISOString(),
        checks: [{ id: "policy-check", verdict: "FAIL" as const, evidence: [], message: "Disallowed network access" }],
      }),
    };
    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "trial-forged-block",
          arm: "A2_blocking",
          ...r4Provenance("r4"),
          task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
          agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
          gateInput: {
            gateId: "G1_SECURITY",
            declaredChecks: [{ id: "policy-check", description: "check", required: true }],
            evidenceRoot: tempDir,
          },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: {
            jobConfigPath: manifestPath,
            jobsRoot: tempDir,
            expectedJobName: "oracle-job",
            timeoutMs: 5000,
            successCriterion: "reward >= 1.0",
            expectedTaskChecksum: authenticOracleChecksum,
          },
          ndjsonPath,
          completionGate: failingGate,
          harborSession: session,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.match(err.message, /not an expected A2 gate block/);
        return true;
      },
    );
    // The rejected attempt is still recorded as a job-level failure—and
    // never as a GOVERNANCE_FAILURE block.
    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.failureClassification, "VERIFIER_FAILURE");
    assert.notEqual(records[0]?.execution.finalStopReason, "gate_blocked_exhausted");
    assert.equal(records[0]?.verifier, null);
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R8: MUTATION COUNTERFEIT_UV_AND_BRIDGE_INHERIT_WHEEL_VERIFIED - tampered bridge fails before any execution", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-r8-counterfeit-bridge-"));
  try {
    const tamperedBridge = join(tempDir, "shokunin_intercept_agent.py");
    writeFileSync(tamperedBridge, readFileSync(BRIDGE_SCRIPT, "utf8") + "\n# counterfeit extension\n");
    let executorCalls = 0;
    const session = newBridgeSession(
      new MockCommandExecutor(async () => {
        executorCalls += 1;
        return createDummyResult(0);
      }),
      { bridgeScriptPath: tamperedBridge },
    );
    await assert.rejects(
      () =>
        session.executeSession({
          jobConfigPath: join(tempDir, "missing.yaml"),
          jobsRoot: tempDir,
          expectedJobName: "oracle-job",
          timeoutMs: 5000,
          successCriterion: "reward >= 1.0",
          expectedTaskChecksum: authenticOracleChecksum,
          arm: "A0_baseline",
          ledgerPath: join(tempDir, "ledger.jsonl"),
          expectedContainerDigest: R4_TEST_DIGEST,
        }),
      /Bridge authentication failed/,
    );
    assert.equal(executorCalls, 0, "tampered bridge must fail before any execution is spawned");
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R6: MUTATION FAILED_ATTEMPT_UNRECORDED - timeout persists a failure record and leaves zero /tmp residuals", async () => {
  const before = new Set(
    (await import("node:fs")).readdirSync((await import("node:os")).tmpdir()).filter((n: string) => n.startsWith("harbor-snapshot-") || n.startsWith("harbor-failure-")),
  );
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-leak-"));
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    // Session whose Harbor invocation times out (probes answered, run hangs).
    const timeoutAdapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        return createDummyResult(null, true, "", "");
      }),
    );
    const ndjsonPath = join(tempDir, "trials.ndjson");
    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "trial-timeout-1",
          arm: "A0_baseline",
          ...r4Provenance("r4"),
          task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
          agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: {
            jobConfigPath: manifestPath,
            jobsRoot: tempDir,
            expectedJobName: "oracle-job",
            timeoutMs: 5000,
            successCriterion: "reward >= 1.0",
            expectedTaskChecksum: authenticOracleChecksum,
          },
          ndjsonPath,
          harborSession: timeoutAdapter,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "TRIAL_TIMEOUT");
        return true;
      },
    );
    // R5: the failed attempt IS recorded (attrition flow), with sealed failure evidence.
    const store = new NDJsonStore(benchmarkTrialSchema);
    const records = await store.readAll(ndjsonPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.failureClassification, "EXOGENOUS_INFRASTRUCTURE_FAILURE");
    assert.equal(records[0]?.execution.finalStopReason, "timeout");
    assert.equal(records[0]?.verifier, null);
  } finally {
    cleanupTestDir(tempDir);
  }
  const after = (await import("node:fs")).readdirSync((await import("node:os")).tmpdir()).filter((n: string) => n.startsWith("harbor-snapshot-") || n.startsWith("harbor-failure-"));
  const leaked = after.filter((n: string) => !before.has(n));
  assert.equal(leaked.length, 0, `Snapshot leak on error: ${leaked.join(", ")}`);
});

test("R6: MUTATION SYMLINK_ESCAPE_UNHASHED - symlinks and externals rejected at seal time", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-symlink-"));
  let outsideDir = "";
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    // External target that changes AFTER the seal attempt.
    outsideDir = mkdtempSync(join(tmpdir(), "harbor-symlink-outside-"));
    writeFileSync(join(outsideDir, "secret.txt"), "version-1");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(outsideDir, "secret.txt"), join(trialDir, "evil-link.txt"));
    const jobId = "a1234567-1234-4123-a123-123456789012";
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "b1234567-1234-4123-b123-123456789012",
          reward: 1.0,
          arm: "A0_baseline",
          snapshotSymlinks: { "evil-link.txt": join(outsideDir, "secret.txt") },
        });
        return createDummyResult(0);
      }),
    );
    const ndjsonPath = join(tempDir, "trials.ndjson");
    // R5 quarantine semantics: an unsealable (symlinked) trial workspace is
    // NOT silently accepted and does NOT crash the batch — it is recorded as
    // a corrupt trial (verifier untrusted → skipped) with failure evidence.
    const result = await executeVerticalSlice({
      trialId: "trial-symlink",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      harborSession: adapter,
    });
    assert.equal(result.trials.length, 1);
    assert.equal(result.trials[0]?.failureClassification, "VERIFIER_FAILURE");
    assert.equal(result.trials[0]?.verifier, null);
    assert.deepEqual(result.trials[0]?.execution.claims, []);
    // Quarantine keeps native correlation (which execution failed).
    assert.equal(result.trials[0]?.harbor?.trialName, "trial-1");
    assert.deepEqual(result.eventLogs[0]?.map((e) => e.event), [
      "agent_started",
      "native_completion_claim",
      "verifier_skipped",
    ]);
    // The gate never observed through the link: failure evidence sealed instead.
    assert.equal(result.trials[0]?.provenance.workspaceSnapshot.originPath.startsWith("failure-context:"), true);
  } finally {
    cleanupTestDir(tempDir);
    if (outsideDir) {
      try {
        makeWritableRecursive(outsideDir);
      } catch { /* ignore */ }
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
});

test("R9: Harbor provider/name identity binds to the configured canonical model", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-model-identity-"));
  let result: VerticalSliceResult | undefined;
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A0_baseline", R4_TEST_DIGEST, "openai/gpt-5-mini");
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId: "a1234567-1234-4123-a123-123456789012",
          trialUuid: "b1234567-1234-4123-b123-123456789012",
          reward: 1.0,
          arm: "A0_baseline",
          agentModel: "gpt-5-mini",
          agentProvider: "openai",
          configuredModel: "openai/gpt-5-mini",
        });
        return createDummyResult(0);
      }),
    );
    result = await executeVerticalSlice({
      trialId: "trial-canonical-model-identity",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: {
        taskId: "task-1",
        taskName: "oracle-task",
        taskChecksum: authenticOracleChecksum,
        benchmarkVersion: R4_BENCHMARK_VERSION,
      },
      agent: {
        agentName: "oracle",
        modelName: "openai/gpt-5-mini",
        promptContent: "x",
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath: join(tempDir, "trials.ndjson"),
      harborSession: adapter,
    });
    assert.equal(result.trial.execution.model, "openai/gpt-5-mini");
    assert.equal(result.trial.verifier?.passed, true);
    const events = await new SessionLedger().readAll(join(tempDir, "session-ledger.jsonl"));
    assert.ok(events.some((event) => event.event === "TRIAL_COMPLETED"));
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: MUTATION UNBOUND_IDENTITIES - trial agent/model/task mismatch yields a recorded corrupt trial, never silent acceptance", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-identities-"));
  let result: VerticalSliceResult | undefined;
  try {
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "81234567-1234-4123-8123-123456789012";
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "91234567-1234-4123-9123-123456789012",
          reward: 1.0,
          arm: "A0_baseline",
          agentName: "different-runtime-agent",
          agentModel: "different-runtime-model",
        });
        return createDummyResult(0);
      }),
    );
    // NOTE: the adapter correlates trial agents against the MANIFEST, so a
    // trial running under a rogue agent is rejected at the session boundary
    // before any canonical record is built.
    await assert.rejects(
      () =>
        executeVerticalSlice({
          trialId: "trial-identities",
          arm: "A0_baseline",
          ...r4Provenance("r4"),
          task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
          agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
          expectedContainerDigest: R4_TEST_DIGEST,
          harborRequest: {
            jobConfigPath: manifestPath,
            jobsRoot: tempDir,
            expectedJobName: "oracle-job",
            timeoutMs: 5000,
            successCriterion: "reward >= 1.0",
            expectedTaskChecksum: authenticOracleChecksum,
          },
          ndjsonPath: join(tempDir, "trials.ndjson"),
          harborSession: adapter,
        }),
      /contradicts manifest agents/,
    );
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: slice-level identity mismatch (unmirrored wrapper identity) records a corrupt trial with verifier_skipped", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-slice-binding-"));
  let result: VerticalSliceResult | undefined;
  try {
    // Multi-agent manifest: options bind to agents[0] (oracle/oracle-v1).
    // The executed trial uses agents[1] (helper): the adapter accepts it
    // (member of the manifest) but the slice records a corrupt trial —
    // options-bound identities are never silently swapped.
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "82134567-1234-4123-8123-123456789012";
    const adapter = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        // Bridge bug simulation: agent_info mirrors the WRAPPER instead of
        // the inner experiment agent. The adapter accepts it (manifest
        // member) but the slice quarantines (options binding violated).
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "92134567-1234-4123-9123-123456789012",
          reward: 1.0,
          arm: "A0_baseline",
          agentName: "shokunin-intercept",
        });
        return createDummyResult(0);
      }),
    );
    const ndjsonPath = join(tempDir, "trials.ndjson");
    result = await executeVerticalSlice({
      trialId: "trial-binding",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      harborSession: adapter,
    });
    // No throw: the corrupt trial is RECORDED (verifier untrusted → skipped).
    assert.equal(result.trials.length, 1);
    assert.equal(result.trials[0]?.failureClassification, "VERIFIER_FAILURE");
    assert.equal(result.trials[0]?.verifier, null);
    assert.deepEqual(result.eventLogs[0]?.map((e) => e.event), [
      "agent_started",
      "native_completion_claim",
      "verifier_skipped",
    ]);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: NDJsonStore exactly-once - duplicates rejected, torn tails detected and repaired", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-store-tx-"));
  try {
    const { NDJsonStore } = await import("../src/persistence/ndjson-store.js");
    const { repairPartialTail } = await import("../src/persistence/ndjson-store.js");
    const { z } = await import("zod");
    const recordSchema = z.object({ id: z.string().min(1), value: z.number() });
    const store = new NDJsonStore(recordSchema, { idOf: (r) => (r as { id: string }).id });
    const filePath = join(tempDir, "evidence.ndjson");
    await store.appendBatch(filePath, [{ id: "a", value: 1 }]);
    // Duplicate within batch.
    await assert.rejects(
      () => store.appendBatch(filePath, [{ id: "b", value: 2 }, { id: "b", value: 3 }]),
      /Duplicate record ID "b" within appendBatch/,
    );
    // Duplicate against existing file.
    await assert.rejects(
      () => store.appendBatch(filePath, [{ id: "a", value: 9 }]),
      /Duplicate record ID "a" already present/,
    );
    // Torn tail: append raw partial bytes, detection fails closed.
    writeFileSync(filePath, '{"id":"torn","value":', { flag: "a" });
    await assert.rejects(() => store.readAll(filePath), /Partial \(torn\) tail detected/);
    // Repair truncates to the last complete line; prior records survive.
    const discarded = repairPartialTail(filePath);
    assert.ok(discarded > 0);
    const records = await store.readAll(filePath);
    assert.equal(records.length, 1);
    assert.equal((records[0] as { id: string }).id, "a");
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R7: slow gate is evaluated exactly once per trial (single-flight)", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-slow-gate-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath, "A1_observing");
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";
    // A 500ms gate spans ~5 watch polls (100ms): without single-flight it
    // would be evaluated ~5 times with concurrent verdict writes.
    let gateCalls = 0;
    const slowGate = {
      evaluate: async (input: GateEvaluationInput) => {
        gateCalls += 1;
        await new Promise((r) => setTimeout(r, 500));
        assert.ok(existsSync(join(input.evidenceRoot, "solution.txt")));
        return {
          gateId: "G0_SLOW",
          verdict: "PASS" as const,
          evaluatedAt: new Date().toISOString(),
          checks: [{ id: "slow", verdict: "PASS" as const, evidence: [], message: "ok" }],
        };
      },
    };
    const session = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A1_observing",
        });
        return createDummyResult(0);
      }),
    );
    result = await executeVerticalSlice({
      trialId: "trial-slow-gate",
      arm: "A1_observing",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
      gateInput: {
        gateId: "G0_SLOW",
        declaredChecks: [{ id: "slow", description: "slow check", required: true }],
        evidenceRoot: tempDir,
      },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 30000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      completionGate: slowGate,
      harborSession: session,
    });
    assert.equal(gateCalls, 1, `Slow gate evaluated ${gateCalls}x instead of exactly once.`);
    assert.equal(result.trial.execution.claims[0]?.gateVerdict, "PASS");
    assert.ok(result.trial.verifier !== null);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: NDJsonStore concurrent writers persist the same ID exactly once", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-store-race-"));
  try {
    const childPath = join(packageRoot, "tests/fixtures/store-concurrency-child.mjs");
    if (!existsSync(childPath)) {
      t.skip("concurrency child fixture missing");
      return;
    }
    const filePath = join(tempDir, "evidence.ndjson");
    const { spawn } = await import("node:child_process");
    const runChild = (): Promise<number> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [childPath, filePath], { stdio: "ignore" });
        const timer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch { /* ignore */ }
          resolve(124);
        }, 25000);
        child.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
      });
    const [c1, c2] = await Promise.all([runChild(), runChild()]);
    const succeeded = [c1, c2].filter((c) => c === 0).length;
    assert.equal(succeeded, 1, `Exactly one concurrent writer must win (codes ${c1}, ${c2}).`);
    const { NDJsonStore } = await import("../src/persistence/ndjson-store.js");
    const { z } = await import("zod");
    const recordSchema = z.object({ id: z.string().min(1), value: z.number() });
    const store = new NDJsonStore(recordSchema, { idOf: (r) => (r as { id: string }).id });
    const records = await store.readAll(filePath);
    assert.equal(records.length, 1);
    assert.equal((records[0] as { id: string }).id, "same-attempt");
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R6: bridge module loads without Harbor (argparse only) and prints its protocol", async () => {
  const { spawnSync } = await import("node:child_process");
  const probed = spawnSync("python3", [BRIDGE_SCRIPT, "--help-protocol"], {
    encoding: "utf8",
    timeout: 30000,
    env: PYTHON_NO_BYTECODE_ENV,
  });
  assert.equal(probed.status, 0, `bridge --help-protocol failed: ${probed.stderr}`);
  const protocol = JSON.parse(probed.stdout) as Record<string, string>;
  for (const key of ["claim", "agentOutcome", "containerIdentity", "workspaceSnapshot", "gateRequest", "gateVerdict", "blockedException"]) {
    assert.ok(typeof protocol[key] === "string" && protocol[key].length > 0, `protocol missing ${key}`);
  }
  assert.equal(protocol["blockedException"], "ShokuninGateBlocked");
});

async function runBridgeWitness(scenario: string, trialDir: string): Promise<{ status: number; summary: Record<string, unknown> }> {
  const { spawnSync } = await import("node:child_process");
  const witness = resolve(packageRoot, "tests/fixtures/bridge-witness.py");
  const probed = spawnSync(
    "python3",
    [witness, "--scenario", scenario, "--trial-dir", trialDir, "--job-id", "11111111-1111-4111-8111-111111111111"],
    { encoding: "utf8", timeout: 60000, env: PYTHON_NO_BYTECODE_ENV },
  );
  let summary: Record<string, unknown> = {};
  try {
    const lines = (probed.stdout as string).split("\n");
    // The summary is the first JSON document; an optional second carries failures.
    let depth = 0;
    let end = 0;
    for (let i = 0; i < lines.length; i++) {
      for (const ch of lines[i]!) {
        if (ch === "{") depth += 1;
        if (ch === "}") depth -= 1;
      }
      if (depth === 0 && lines.slice(0, i + 1).join("\n").trim().startsWith("{")) {
        end = i + 1;
        break;
      }
    }
    summary = JSON.parse(lines.slice(0, end).join("\n")) as Record<string, unknown>;
  } catch {
    summary = { stdout: probed.stdout, stderr: probed.stderr };
  }
  return { status: probed.status ?? 1, summary };
}

for (const scenario of ["clean-pass", "block", "timeout", "error", "digest-mismatch"] as const) {
  test(`R7: executable bridge witness runs REAL ShokuninInterceptAgent.run() (${scenario})`, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "harbor-witness-"));
    try {
      const trialDir = join(tempDir, "trial-x");
      mkdirSync(trialDir, { recursive: true });
      const { status, summary } = await runBridgeWitness(scenario, trialDir);
      assert.equal(status, 0, `bridge witness failed for ${scenario}: ${JSON.stringify(summary).slice(0, 800)}`);
      assert.equal(summary["scenario"], scenario);
      assert.equal(summary["innerRunCalls"], 1, "Exactly one inner.run() per trial (double-run sentinel).");
      if (scenario === "clean-pass" || scenario === "block") {
        assert.ok((summary["downloadCalls"] as unknown[]).length > 0, "download_dir() must be awaited and executed.");
        assert.equal(summary["snapshotHasLiveBytes"], true, "Snapshot must contain live container bytes.");
        assert.equal(summary["containerIdDistinctFromImageId"], true, "containerId and imageId stay distinct.");
        assert.equal((summary["claim"] as { declaredDone?: unknown } | null)?.declaredDone, true);
      }
      if (scenario === "block") {
        assert.equal(summary["raised"], "ShokuninGateBlocked");
        assert.equal(summary["gateBlockedExists"], true);
      }
      if (scenario === "timeout") {
        assert.equal(summary["raised"], "CancelledError");
        assert.equal((summary["outcome"] as { reason?: unknown } | null)?.reason, "agent_timeout");
        assert.equal(summary["claim"], null);
      }
      if (scenario === "error") {
        assert.equal(summary["raised"], "RuntimeError");
        assert.equal(summary["claim"], null);
      }
      if (scenario === "digest-mismatch") {
        assert.equal(summary["raised"], "ShokuninDigestMismatch");
      }
    } finally {
      cleanupTestDir(tempDir);
    }
  });
}

test("R8: executable bridge witness performs bounded A3 recovery with diagnostics", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-witness-a3-"));
  try {
    const trialDir = join(tempDir, "trial-x");
    mkdirSync(trialDir, { recursive: true });
    const { status, summary } = await runBridgeWitness("a3-recovery", trialDir);
    assert.equal(status, 0, `A3 bridge witness failed: ${JSON.stringify(summary).slice(0, 1200)}`);
    assert.equal(summary["scenario"], "a3-recovery");
    assert.equal(summary["innerRunCalls"], 4, "A3 must run once plus exactly three bounded retries.");
    const events = summary["recoveryEvents"] as Array<Record<string, unknown>>;
    assert.deepEqual(events.map((event) => [event["attempt"], event["gateVerdict"], event["action"]]), [
      [1, "BLOCK", "retry"], [2, "BLOCK", "retry"], [3, "BLOCK", "retry"], [4, "PASS", "continue"],
    ]);
    const instructions = summary["instructions"] as string[];
    assert.equal(instructions.length, 4);
    assert.ok(instructions.slice(1).every((instruction) => instruction.includes("witness block")));
    assert.equal(summary["raised"], null);
    assert.equal(summary["snapshotHasLiveBytes"], true);
  } finally {
    cleanupTestDir(tempDir);
  }
});

test("R6: bridge agent class imports inside the REAL Harbor 0.1.2 environment", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const bridgeDir = dirname(BRIDGE_SCRIPT);
  const probe = spawnSync(
    "uv",
    [
      "run", "--python", "3.12",
      "--with-requirements", lockPath,
      "--with", wheelPath,
      "python3", "-c",
      `import sys; sys.path.insert(0, ${JSON.stringify(bridgeDir)}); from shokunin_intercept_agent import ShokuninInterceptAgent; a = ShokuninInterceptAgent(logs_dir='/tmp/x', model_name=None); print(a.name()); print(a.version())`,
    ],
    {
      encoding: "utf8",
      timeout: 120000,
      env: PYTHON_NO_BYTECODE_ENV,
    },
  );
  if (probe.status !== 0) {
    t.skip(`Harbor env unavailable for bridge import probe: ${(probe.stderr || "").slice(0, 200)}`);
    return;
  }
  assert.match(probe.stdout, /shokunin-intercept/);
  // R8 item 7 / P2: the loaded bridge reports the allowlisted release.
  assert.match(probe.stdout, /1\.0\.0-r8\.3/);
});

test("R6: ledger records job STARTED before execution plus per-trial terminals", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-ledger-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";
    const session = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 1.0,
          arm: "A0_baseline",
        });
        return createDummyResult(0);
      }),
    );
    result = await executeVerticalSlice({
      trialId: "trial-ledger-1",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      harborSession: session,
    });
    assert.ok(result);
    const ledger = new SessionLedger();
    const events = await ledger.readAll(join(tempDir, "session-ledger.jsonl"));
    const kinds = events.map((e) => `${e.scope}:${e.event}`);
    assert.ok(kinds.includes("job:STARTED"), `ledger lacks job STARTED: ${kinds.join(",")}`);
    assert.ok(kinds.includes("job:SESSION_COMPLETED"), `ledger lacks SESSION_COMPLETED: ${kinds.join(",")}`);
    assert.ok(
      kinds.includes("trial:TRIAL_COMPLETED"),
      `ledger lacks trial terminal: ${kinds.join(",")}`,
    );
    const started = events.find((e) => e.event === "STARTED");
    const terminal = events.find((e) => e.scope === "trial");
    assert.ok(
      new Date(started!.timestamp).getTime() <= new Date(terminal!.timestamp).getTime(),
      "STARTED must precede terminal transitions",
    );
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

test("R6: agent timeout keeps the verifier that ran, with no claim and timeout stop", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-timeout-keeps-"));
  let result: VerticalSliceResult | undefined;
  try {
    const ndjsonPath = join(tempDir, "trials.ndjson");
    const manifestPath = join(tempDir, "job-config.yaml");
    writeOracleManifest(manifestPath);
    const jobDir = join(tempDir, "oracle-job");
    const trialDir = join(jobDir, "trial-1");
    mkdirSync(trialDir, { recursive: true });
    const jobId = "aa6ea252-9817-4c82-b432-4f6bf957d3e3";
    const session = newBridgeSession(
      new MockCommandExecutor(async (req) => {
        const probe = probeRoute(req);
        if (probe) return probe;
        await simulateBridgeRun({
          jobDir,
          trialDir,
          jobId,
          trialUuid: "e5f342af-b755-4208-9ebf-9f8dee679189",
          reward: 0.0,
          behavior: "timeout",
          arm: "A0_baseline",
        });
        return createDummyResult(0);
      }),
    );
    result = await executeVerticalSlice({
      trialId: "trial-timeout-keeps-1",
      arm: "A0_baseline",
      ...r4Provenance("r4"),
      task: { taskId: "task-1", taskName: "oracle-task", taskChecksum: authenticOracleChecksum, benchmarkVersion: R4_BENCHMARK_VERSION },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "x" },
      expectedContainerDigest: R4_TEST_DIGEST,
      harborRequest: {
        jobConfigPath: manifestPath,
        jobsRoot: tempDir,
        expectedJobName: "oracle-job",
        timeoutMs: 5000,
        successCriterion: "reward >= 1.0",
        expectedTaskChecksum: authenticOracleChecksum,
      },
      ndjsonPath,
      harborSession: session,
    });
    // Harbor runs the verifier even after agent timeouts: the record keeps the
    // observed verifier, carries NO claim, and stops as timeout (R6 item 2).
    assert.deepEqual(result.trial.execution.claims, []);
    assert.ok(result.trial.verifier !== null, "Timeout must keep the verifier that ran.");
    assert.equal(result.trial.execution.finalStopReason, "timeout");
    assert.equal(result.trial.metrics.falseCompletionTerminal, null);
    // R8 item 4: A0 never logs gate_evaluated — no gate was requested.
    assert.deepEqual(result.eventLog.map((e) => e.event), [
      "agent_started",
      "snapshot_sealed",
      "verifier_finished",
    ]);
  } finally {
    cleanupTestDir(tempDir, result);
  }
});

// ---------------------------------------------------------------------------
// 7. CLI Integration Wire-Test with Bubblewrap Runtime Double (Honest Naming)
// ---------------------------------------------------------------------------

test("run: CLI integration wire-test with bubblewrap runtime double (simulated docker daemon) and guarantees teardown", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-wire-test-"));
  const binDir = join(tempDir, "bin");
  const containerDir = join(tempDir, "container");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(join(containerDir, "app"), { recursive: true });
  mkdirSync(join(containerDir, "logs/agent"), { recursive: true });
  mkdirSync(join(containerDir, "logs/verifier"), { recursive: true });
  mkdirSync(join(containerDir, "solution"), { recursive: true });
  mkdirSync(join(containerDir, "tests"), { recursive: true });
  mkdirSync(join(tempDir, "jobs"), { recursive: true });

  const mockDocker = join(binDir, "docker");
  const dockerScript = [
    "#!/usr/bin/env python3",
    "import sys, os, shutil, subprocess",
    "from pathlib import Path",
    "",
    `container = Path('${containerDir}')`,
    "args = sys.argv[1:]",
    "",
    "if 'build' in args or 'up' in args or 'down' in args:",
    "    sys.exit(0)",
    "",
    "if 'cp' in args:",
    "    cp_idx = args.index('cp')",
    "    src = args[cp_idx + 1]",
    "    dst = args[cp_idx + 2]",
    "    if src.startswith('main:'):",
    "        rel = src[5:].lstrip('/')",
    "        src_path = container / rel",
    "        dst_path = Path(dst)",
    "        if src_path.is_dir():",
    "            shutil.copytree(src_path, dst_path, dirs_exist_ok=True)",
    "        elif src_path.exists():",
    "            dst_path.parent.mkdir(parents=True, exist_ok=True)",
    "            shutil.copy2(src_path, dst_path)",
    "    elif dst.startswith('main:'):",
    "        rel = dst[5:].lstrip('/')",
    "        dst_path = container / rel",
    "        src_path = Path(src)",
    "        if src_path.is_dir():",
    "            shutil.copytree(src_path, dst_path, dirs_exist_ok=True)",
    "        elif src_path.exists():",
    "            dst_path.parent.mkdir(parents=True, exist_ok=True)",
    "            shutil.copy2(src_path, dst_path)",
    "    sys.exit(0)",
    "",
    "if 'exec' in args:",
    "    main_idx = args.index('main')",
    "    cmd = args[main_idx + 1:]",
    "    bwrap_cmd = [",
    "        'bwrap',",
    "        '--tmpfs', '/',",
    "        '--ro-bind', '/usr', '/usr',",
    "        '--symlink', 'usr/lib', '/lib',",
    "        '--symlink', 'usr/lib64', '/lib64',",
    "        '--symlink', 'usr/bin', '/bin',",
    "        '--symlink', 'usr/sbin', '/sbin',",
    "        '--ro-bind', '/etc', '/etc',",
    "        '--dev', '/dev',",
    "        '--proc', '/proc',",
    "        '--tmpfs', '/tmp',",
    "        '--dir', '/app',",
    "        '--bind', str(container / 'app'), '/app',",
    "        '--dir', '/logs',",
    "        '--bind', str(container / 'logs'), '/logs',",
    "        '--dir', '/solution',",
    "        '--bind', str(container / 'solution'), '/solution',",
    "        '--dir', '/tests',",
    "        '--bind', str(container / 'tests'), '/tests',",
    "        *cmd",
    "    ]",
    "    proc = subprocess.run(bwrap_cmd, capture_output=True, text=True)",
    "    sys.stdout.write(proc.stdout)",
    "    sys.stderr.write(proc.stderr)",
    "    sys.exit(proc.returncode)",
    "",
    "sys.exit(0)",
  ].join("\n");
  writeFileSync(mockDocker, dockerScript);
  chmodSync(mockDocker, 0o755);

  try {
    const rawYaml = readFileSync(resolve(fixturesDir, "job-config.yaml"), "utf8");
    const cfg = yaml.parse(rawYaml);
    cfg["jobs_dir"] = join(tempDir, "jobs");
    cfg["tasks"] = [{ path: resolve(fixturesDir, "oracle-task") }];

    const manifestPath = join(tempDir, "job-config.yaml");
    writeFileSync(manifestPath, yaml.stringify(cfg));

    const pathEnv = `${binDir}:${process.env["PATH"] ?? ""}`;
    const adapter = new HarborAdapter({
      harborExecutable: "uv",
      harborPrefixArgs: [
        "run",
        "--python",
        "3.12",
        "--with-requirements",
        lockPath,
        "--with",
        wheelPath,
        "python3",
        "-m",
        "harbor.cli.sb.main",
      ],
      env: { PATH: pathEnv },
    });

    const jobRequest: HarborJobRequest = {
      jobConfigPath: manifestPath,
      jobsRoot: join(tempDir, "jobs"),
      expectedJobName: "oracle-job",
      timeoutMs: 60000,
      successCriterion: "reward >= 1.0",
      taskDirectory: resolve(fixturesDir, "oracle-task"),
    };

    const result = await adapter.run(jobRequest);

    assert.equal(result.exitCode, 0);
    assert.equal(result.trials.length, 1);
    assert.equal(result.trials[0]?.jobName, "oracle-job");
    assert.ok(result.trials[0]?.trialName.startsWith("oracle-task__"));
    assert.ok(statSync(result.trials[0].resultPath).isFile());
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Integration: Real Docker / Podman Host Daemon Preflight & Execution Gate
// ---------------------------------------------------------------------------

test("integration: real Docker/Podman host daemon preflight and execution gate", async (t) => {
  const { resolveLaunchAuthority } = await import("../src/sessions/launch-authority.js");
  // R8 item 5: readiness is established through the SAME uv+wheel launcher
  // the production session executes — never through a global harbor binary.
  // Tampered vendored files fail loudly here (repo integrity); a missing uv
  // or container daemon skips via the preflight gate below.
  const hostEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) hostEnv[key] = value;
  }
  const hostExec = new LocalCommandExecutor();
  const probeRuntime = async (command: "docker" | "podman") =>
    hostExec.execute({
      command,
      args: ["info"],
      cwd: process.cwd(),
      env: hostEnv,
      timeoutMs: 10000,
    });
  const dockerProbe = await probeRuntime("docker");
  const podmanProbe = dockerProbe.exitCode === 0 ? null : await probeRuntime("podman");
  const containerRuntime: "docker" | "podman" | null =
    dockerProbe.exitCode === 0
      ? "docker"
      : podmanProbe?.exitCode === 0
        ? "podman"
        : null;
  if (containerRuntime === null) {
    t.skip("[GATE BLOCKED / NOT_RUN]: neither Docker nor Podman is operational on this host.");
    return;
  }
  if (containerRuntime === "podman") {
    const { PODMAN_DOCKER_COMPAT_SHA256 } = await import("../src/adapters/bridge-allowlist.js");
    const { createHash } = await import("node:crypto");
    const podmanCompatDir = resolve(packageRoot, "bridge/podman-compat");
    const podmanCompatLauncher = resolve(podmanCompatDir, "docker");
    assert.equal(
      statSync(podmanCompatLauncher).mode & 0o111,
      0o111,
      "Podman compatibility launcher must remain executable.",
    );
    const observedLauncherHash = createHash("sha256")
      .update(readFileSync(podmanCompatLauncher))
      .digest("hex");
    assert.equal(
      observedLauncherHash,
      PODMAN_DOCKER_COMPAT_SHA256,
      "Refuse to execute a Podman compatibility launcher outside the lab-owned digest.",
    );
    hostEnv["PATH"] = `${podmanCompatDir}${delimiter}${hostEnv["PATH"] ?? ""}`;
    const compatibilityProbe = await hostExec.execute({
      command: "docker",
      args: ["compose", "version"],
      cwd: process.cwd(),
      env: hostEnv,
      timeoutMs: 120000,
    });
    assert.equal(
      compatibilityProbe.exitCode,
      0,
      `Podman compatibility layer is not operational: ${compatibilityProbe.stderr || compatibilityProbe.stdout}`,
    );
  }
  const authority = resolveLaunchAuthority({
    launch: { kind: "uv-wheel", requirementsLockPath: lockPath },
    env: hostEnv,
    wheelPath,
    bridgeScriptPath: BRIDGE_SCRIPT,
  });
  if (authority.resolvedCommand === null) {
    t.skip("[GATE BLOCKED / NOT_RUN]: uv unresolvable: cannot attest wheel execution on host.");
    return;
  }
  const adapter = new HarborAdapter({
    harborExecutable: authority.command,
    harborPrefixArgs: [...authority.prefixArgs],
    containerRuntime,
    env: hostEnv,
  });

  try {
    await adapter.preflight({ checkHarbor: true, checkContainerRuntime: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    t.skip(`[GATE BLOCKED / NOT_RUN]: Real container daemon or Harbor CLI unavailable on host (${message}). Gate G2 requires real operational Docker/Podman daemon and Harbor CLI.`);
    return;
  }

  // If container engine and Harbor CLI are genuinely operational on host, execute full real run
  const tempDir = mkdtempSync(join(tmpdir(), "harbor-real-host-gate-"));
  let sliced: VerticalSliceResult | undefined;
  try {
    const taskDir = resolve(fixturesDir, "oracle-task");
    const rawYaml = readFileSync(resolve(fixturesDir, "job-config.yaml"), "utf8");
    const cfg = yaml.parse(rawYaml);
    const jobsDir = join(tempDir, "jobs");
    mkdirSync(jobsDir, { recursive: true });
    cfg["jobs_dir"] = jobsDir;
    cfg["tasks"] = [{ path: taskDir }];
    cfg["environment"] = {
      ...(cfg["environment"] as Record<string, unknown>),
      // Preserve the freshly built image until its immutable ID has been
      // captured for the bridge run. Phase 2 deletes it after use.
      delete: false,
    };

    const manifestPath = join(tempDir, "job-config.yaml");
    writeFileSync(manifestPath, yaml.stringify(cfg));

    const result = await adapter.run({
      jobConfigPath: manifestPath,
      jobsRoot: jobsDir,
      expectedJobName: "oracle-job",
      timeoutMs: 120000,
      successCriterion: "reward >= 1.0",
      taskDirectory: taskDir,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(result.trials.length >= 1);

    // Phase 2 (R7 item 10, R8 item 5): the same host traverses the
    // interception session and the vertical slice — not just the monolithic
    // adapter. No global binary is probed here: uv resolvability was already
    // established by the launch authority above (skip if unresolved).
    let pin = "";
    for (const imageRef of ["sb__oracle-task", "localhost/sb__oracle-task:latest"]) {
      const imageProbe = await hostExec.execute({
        command: "docker",
        args: ["image", "inspect", imageRef, "--format", "{{.Id}}"],
        cwd: tempDir,
        env: hostEnv,
        timeoutMs: 30000,
      });
      const observedId = (imageProbe.stdout || "").trim();
      const candidate = /^[0-9a-f]{64}$/i.test(observedId)
        ? `sha256:${observedId}`
        : observedId;
      if (imageProbe.exitCode === 0 && /^sha256:[0-9a-f]{64}$/i.test(candidate)) {
        pin = candidate;
        break;
      }
    }
    assert.match(
      pin,
      /^sha256:[0-9a-f]{64}$/i,
      "A successful real Harbor build must expose the immutable sb__oracle-task image ID.",
    );
    const bridgeManifestPath = join(tempDir, "bridge-job-config.yaml");
    writeFileSync(
      bridgeManifestPath,
      yaml.stringify({
        ...cfg,
        job_name: "oracle-job-bridge",
        agents: [
          {
            name: "shokunin-intercept",
            import_path: BRIDGE_IMPORT,
            model_name: "oracle-v1",
            kwargs: {
              shokunin_inner_agent: "oracle",
              shokunin_arm: "A0_baseline",
              shokunin_expected_digest: pin,
              shokunin_verdict_timeout_sec: 120,
            },
          },
        ],
        environment: {
          ...(cfg["environment"] as Record<string, unknown>),
          force_build: false,
          delete: true,
        },
      }),
    );
    const session = new HarborBridgeSession({
      executor: new LocalCommandExecutor(),
      launch: { kind: "uv-wheel", requirementsLockPath: lockPath },
      bridgeScriptPath: BRIDGE_SCRIPT,
      wheelPath: wheelPath,
      env: hostEnv,
    });
    const ndjsonPath = join(tempDir, "host-trials.ndjson");
    sliced = await executeVerticalSlice({
      trialId: "trial-host-slice-1",
      arm: "A0_baseline",
      experimentId: "exp-host-witness",
      campaignId: "host",
      hypothesisId: "H1_COMPLIANCE_GATE",
      repetitionIndex: 0,
      runtimeId: "host-docker",
      runtimeVersion: "host",
      task: {
        taskId: "task-1",
        taskName: "oracle-task",
        taskChecksum: computeTaskChecksum(taskDir),
        benchmarkVersion: "fixture-1.0",
      },
      agent: { agentName: "oracle", modelName: "oracle-v1", promptContent: "host witness" },
      expectedContainerDigest: pin,
      harborRequest: {
        jobConfigPath: bridgeManifestPath,
        jobsRoot: jobsDir,
        expectedJobName: "oracle-job-bridge",
        timeoutMs: 600000,
        successCriterion: "reward >= 1.0",
        taskDirectory: taskDir,
      },
      ndjsonPath,
      harborSession: session,
    });
    assert.equal(sliced.trials.length, 1);
    assert.equal(sliced.trial.execution.claims.length, 1);
    assert.equal(sliced.trial.execution.claims[0]?.gateVerdict, "NOT_EVALUATED");
    assert.ok(sliced.trial.verifier !== null, "Host slice keeps the native verifier.");
    assert.equal(sliced.trial.harbor?.containerDigest.toLowerCase(), pin.toLowerCase());
    assert.equal(sliced.trial.distribution, "wheel-verified");
    assert.ok(existsSync(sliced.snapshotDirectory!));
  } finally {
    cleanupTestDir(tempDir, sliced);
  }
});
