import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  LocalCommandExecutor,
  type ICommandExecutor,
} from "@shokunin/core";
import type { HarborJobRequest } from "../../contracts/harbor.contract.js";
import type {
  GateDecider,
  HarborDistributionAttestation,
  HarborLaunchSpec,
  HarborSessionJob,
  HarborSessionRequest,
  HarborSessionTrialNative,
  IPhasedHarborSession,
} from "../../contracts/runtime-protocol.contract.js";
import { HarborAdapter, evaluateSuccessCriterion } from "../adapters/harbor-adapter.js";
import {
  PINNED_HARBOR_VERSION,
} from "../adapters/harbor-distribution-allowlist.js";
import { resolveLaunchAuthority } from "./launch-authority.js";
import { computeTaskChecksum } from "../crypto/dirhash.js";
import {
  assertNoSpecialFiles,
  makeReadOnlyRecursive,
  makeWritableRecursive,
} from "../snapshots/snapshot-fs.js";
import {
  harborJobResultSchema,
  harborTrialResultSchema,
} from "../../schemas/harbor.schema.js";
import { ociDigestSchema, sha256HexSchema } from "../../schemas/trial.schema.js";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";
import { SessionLedger } from "../persistence/session-ledger.js";
import {
  claimSidecarSchema,
  containerIdentitySidecarSchema,
  exportManifestSidecarSchema,
  gateBlockedSidecarSchema,
  gateRequestSidecarSchema,
  gateVerdictSidecarSchema,
  isProvenGateBlock,
  outcomeSidecarSchema,
  parseSidecar,
  recoveryEventsSidecarSchema,
} from "../adapters/sidecars.js";
import { deriveRecoverySuccessful } from "../metrics/recovery-success.js";

export interface HarborBridgeSessionOptions {
  readonly executor?: ICommandExecutor | undefined;
  /** Closed launch specification (the session builds the command). */
  readonly launch: HarborLaunchSpec;
  /** Absolute path to bridge/shokunin_intercept_agent.py (dirname → PYTHONPATH). */
  readonly bridgeScriptPath: string;
  /** Absolute path to the official Harbor wheel (hash-checked vs allowlist). */
  readonly wheelPath: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

// Bridge sidecar filenames (mirror bridge/shokunin_intercept_agent.py).
const CLAIM_FILE = "claim.json";
const AGENT_OUTCOME_FILE = "agent-outcome.json";
const CONTAINER_IDENTITY_FILE = "container-identity.json";
const EXPORT_MANIFEST_FILE = "export-manifest.json";
const WORKSPACE_SNAPSHOT_DIR = "workspace-snapshot";
const GATE_REQUEST_FILE = "gate-request.json";
const GATE_VERDICT_FILE = "gate-verdict.json";
const GATE_BLOCKED_FILE = "gate-blocked.json";
const HARBOR_VERSION_FILE = "harbor-version.json";

function failConfig(message: string, remediation: string, details?: Record<string, unknown>): never {
  throw new ActionableBenchmarkError({
    code: "CONFIG_INVALID",
    message,
    remediation,
    retryable: false,
    ...(details ? { details } : {}),
  });
}

/**
 * Production in-runtime interception session (R6).
 *
 * Spawns exactly one Harbor run whose trials carry the lab-owned bridge agent
 * (manifest `import_path`), serves live gate verdicts concurrently while the
 * containers are still alive, then derives per-trial natives from the run's
 * artefacts plus bridge sidecars. Trust anchor: the wheel file hash compared
 * against the immutable laboratory allowlist — no caller-supplied hash can
 * validate (R5 self-attestation flaw deleted).
 */
export class HarborBridgeSession implements IPhasedHarborSession {
  private readonly executor: ICommandExecutor;
  private readonly launch: HarborLaunchSpec;
  private readonly bridgeScriptPath: string;
  private readonly wheelPath: string;
  private readonly env?: Readonly<Record<string, string>> | undefined;
  private readonly ledger = new SessionLedger();

  constructor(options: HarborBridgeSessionOptions) {
    if (!options.launch || (options.launch.kind !== "uv-wheel" && options.launch.kind !== "plain")) {
      failConfig("HarborBridgeSession requires an explicit closed launch spec.", "Provide launch {kind:'uv-wheel',...} or {kind:'plain', executable}.");
    }
    if (!options.bridgeScriptPath || !existsSync(options.bridgeScriptPath)) {
      failConfig(
        `Bridge script not found: "${options.bridgeScriptPath}".`,
        "Provide the absolute path to bridge/shokunin_intercept_agent.py.",
      );
    }
    if (!options.wheelPath || !existsSync(options.wheelPath)) {
      failConfig(
        `Harbor wheel not found: "${options.wheelPath}".`,
        "Provide the absolute path to the official Harbor distribution wheel.",
      );
    }
    this.executor = options.executor ?? new LocalCommandExecutor();
    this.launch = options.launch;
    this.bridgeScriptPath = options.bridgeScriptPath;
    this.wheelPath = options.wheelPath;
    this.env = options.env;
  }

  /**
   * Closed launcher factory (R7 item 5, R8 authority): the exact spawn
   * command AND its trust identity derive from resolveLaunchAuthority, which
   * compares wheel and bridge bytes against lab-owned authorities. Callers
   * cannot inject an arbitrary command, so a counterfeit binary cannot
   * smuggle the real wheel path; an unresolvable/arbitrary uv stays
   * cli-shape-only and never inherits wheel trust.
   */
  private resolveLauncher(): { command: string; prefixArgs: readonly string[]; wheelVerified: boolean; wheelSha256: string; bridgeSha256: string; bridgeVersion: string | null } {
    const authority = resolveLaunchAuthority({
      launch: this.launch,
      env: this.env,
      wheelPath: this.wheelPath,
      bridgeScriptPath: this.bridgeScriptPath,
    });
    return {
      command: authority.command,
      prefixArgs: authority.prefixArgs,
      wheelVerified: authority.identity === "wheel-verified",
      wheelSha256: authority.wheelSha256,
      bridgeSha256: authority.bridgeSha256,
      bridgeVersion: authority.bridgeVersion,
    };
  }

  async executeSession(request: HarborSessionRequest): Promise<HarborSessionJob> {
    const startedAt = new Date().toISOString();

    // Independent authority FIRST (R6 item 5, R7 closed factory): the wheel
    // bytes AND the resolved launcher are established here. A counterfeit
    // binary cannot smuggle the real wheel path into free-form arguments
    // because the command is built by this factory, not supplied by callers.
    const resolved = this.resolveLauncher();
    const wheelSha256 = resolved.wheelSha256;
    const bridgeSha256 = resolved.bridgeSha256;
    const bridgeVersion = resolved.bridgeVersion;

    this.validateRequest(request);
    const identity = resolved.wheelVerified ? "wheel-verified" : "cli-shape-only";

    const targetJobDir = resolve(request.jobsRoot, request.expectedJobName);
    await this.ledger.append(request.ledgerPath, {
      event: "STARTED",
      scope: "job",
      jobName: request.expectedJobName,
      timestamp: startedAt,
      detail: {
        launcher: [resolved.command, ...resolved.prefixArgs].join(" "),
        launcherKind: this.launch.kind,
        wheelSha256,
        bridgeSha256,
        bridgeVersion,
        wheelIdentity: identity,
      },
    });

    // The bridge module must be importable inside the Harbor runtime env.
    const bridgeDir = dirname(resolve(this.bridgeScriptPath));
    const baseEnv = this.env ?? process.env as Readonly<Record<string, string>>;
    const spawnEnv: Record<string, string> = { ...(baseEnv as Record<string, string>) };
    // Importing the bridge from the source tree must never leave Python
    // bytecode residue in the evidence-controlled package.
    spawnEnv["PYTHONDONTWRITEBYTECODE"] = "1";
    spawnEnv["PYTHONPATH"] = spawnEnv["PYTHONPATH"]
      ? `${bridgeDir}${delimiter}${spawnEnv["PYTHONPATH"]}`
      : bridgeDir;

    const adapter = new HarborAdapter({
      executor: this.executor,
      harborExecutable: resolved.command,
      harborPrefixArgs: resolved.prefixArgs,
      env: spawnEnv,
    });

    const jobRequest = {
      jobConfigPath: request.jobConfigPath,
      jobsRoot: request.jobsRoot,
      expectedJobName: request.expectedJobName,
      timeoutMs: request.timeoutMs,
      successCriterion: request.successCriterion,
      ...(typeof request.expectedTaskChecksum === "string"
        ? { expectedTaskChecksum: request.expectedTaskChecksum }
        : {}),
      ...(typeof request.taskDirectory === "string"
        ? { taskDirectory: request.taskDirectory }
        : {}),
    } as unknown as HarborJobRequest;

    // Single Harbor invocation + concurrent gate service while containers live.
    // Single-flight per trial (R7 item 5): in-flight requests are tracked so
    // a slow gate is evaluated EXACTLY ONCE no matter how many polls observe
    // the pending request. All in-flight evaluations are awaited before the
    // session returns.
    let settled = false;
    const gateDecider = request.gateDecider;
    const arm = request.arm;
    if ((arm === "A1_observing" || arm === "A2_blocking" || arm === "A3_recovering") && !gateDecider) {
      failConfig(
        `gateDecider is required for arm "${arm}" (live verdicts during the session).`,
        "Provide request.gateDecider evaluating the exported snapshot.",
      );
    }
    const inFlight = new Map<string, Promise<void>>();

    const watchLoop = (async (): Promise<void> => {
      while (!settled) {
        try {
          this.serveGateRequests(targetJobDir, arm, gateDecider, inFlight);
        } catch {
          // Watch-loop errors must not kill the session; the post-join sweep
          // fails closed on unanswered requests.
        }
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
      }
      const pending = [...inFlight.values()];
      if (pending.length > 0) {
        await Promise.all(pending);
      }
    })();

    let jobResult;
    try {
      // Bridge sessions tolerate ONLY proven A2 gate blocks (GateBlocked-only
      // exception + absent verifier + BLOCK transcript, verified per trial
      // inside run()); every other error shape still fails closed there.
      jobResult = await adapter.run(jobRequest, { allowExpectedGateBlocked: true });
    } catch (err) {
      settled = true;
      try {
        await watchLoop;
      } catch {
        // ignore watch termination
      }
      await this.ledger.append(request.ledgerPath, {
        event: "SESSION_FAILED",
        scope: "job",
        jobName: request.expectedJobName,
        timestamp: new Date().toISOString(),
        detail: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
    settled = true;
    await watchLoop;

    // Post-join sweep: a gate request without verdict means the bridge died
    // awaiting it — fail closed, never silently pass.
    this.assertNoUnansweredRequests(targetJobDir);

    const jobResultPath = join(jobResult.jobDirectory, "result.json");
    const jobBytes = readFileSync(jobResultPath, "utf8");
    const parsedJob = harborJobResultSchema.parse(JSON.parse(jobBytes));
    const jobResultHash = createHash("sha256").update(jobBytes).digest("hex");

    const versionInfo = this.readVersionFile(jobResult.jobDirectory);
    const distribution = {
      identity,
      harborVersion: versionInfo.version,
      versionSource: versionInfo.source,
      wheelSha256,
      bridgeSha256,
      bridgeVersion,
    } as HarborDistributionAttestation;

    const trials: HarborSessionTrialNative[] = [];
    for (const ref of jobResult.trials) {
      trials.push(this.readNativeTrial(ref.resultPath, request, distribution));
    }

    await this.ledger.append(request.ledgerPath, {
      event: "SESSION_COMPLETED",
      scope: "job",
      jobName: request.expectedJobName,
      timestamp: new Date().toISOString(),
      detail: {
        sessionRunId: parsedJob.id,
        trialCount: trials.length,
        harborVersion: distribution.harborVersion,
        versionSource: distribution.versionSource,
      },
    });

    return {
      sessionRunId: parsedJob.id,
      jobDirectory: jobResult.jobDirectory,
      jobResultHash,
      effectiveContainerDigest: trials.length > 0 ? trials[0]!.containerDigestEffective : "",
      bridgeSha256,
      distribution,
      trials,
    };
  }

  private validateRequest(request: HarborSessionRequest): void {
    if (!existsSync(request.jobConfigPath)) {
      failConfig(`Job config file not found: "${request.jobConfigPath}".`, "Ensure jobConfigPath exists on disk.");
    }
    if (!existsSync(request.jobsRoot)) {
      failConfig(`jobsRoot directory not found: "${request.jobsRoot}".`, "Ensure jobsRoot exists before the session.");
    }
    if (!request.expectedJobName || typeof request.expectedJobName !== "string") {
      failConfig("HarborSessionRequest.expectedJobName must be a non-empty string.", "Specify the expected job directory name.");
    }
    if (typeof request.timeoutMs !== "number" || request.timeoutMs <= 0 || !Number.isFinite(request.timeoutMs)) {
      failConfig("HarborSessionRequest.timeoutMs must be a positive finite number.", "Specify a timeoutMs value > 0.");
    }
    if (!request.successCriterion || typeof request.successCriterion !== "string") {
      failConfig("HarborSessionRequest.successCriterion must be a non-empty string.", "Specify a success criterion such as 'reward >= 1.0'.");
    }
    if (!["A0_baseline", "A1_observing", "A2_blocking", "A3_recovering"].includes(request.arm)) {
      failConfig(
        `Unsupported arm "${(request as { arm?: unknown }).arm}" for interception sessions.`,
        "Use A0_baseline, A1_observing, A2_blocking or A3_recovering.",
      );
    }
    ociDigestSchema.parse(request.expectedContainerDigest);
    if (!request.ledgerPath || typeof request.ledgerPath !== "string") {
      failConfig("HarborSessionRequest.ledgerPath must be a non-empty string.", "Provide the durable session ledger path.");
    }
    const ledgerParent = dirname(resolve(request.ledgerPath));
    if (!existsSync(ledgerParent)) {
      mkdirSync(ledgerParent, { recursive: true });
    }
  }

  private serveGateRequests(
    targetJobDir: string,
    expectedArm: HarborSessionRequest["arm"],
    gateDecider: GateDecider | undefined,
    inFlight: Map<string, Promise<void>>,
  ): void {
    let entries: string[];
    try {
      entries = readdirSync(targetJobDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const trialDir = join(targetJobDir, entry);
      try {
        if (!statSync(trialDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const requestPath = join(trialDir, GATE_REQUEST_FILE);
      const verdictPath = join(trialDir, GATE_VERDICT_FILE);
      if (!existsSync(requestPath) || existsSync(verdictPath)) continue;
      // Single-flight (R7 item 5): a request already being evaluated is never
      // started again, however many polls observe it pending.
      if (inFlight.has(trialDir)) continue;
      let gateRequestRaw: unknown;
      try {
        gateRequestRaw = readJsonFile(requestPath);
      } catch {
        gateRequestRaw = null;
      }
      const gateRequest = parseSidecar(gateRequestSidecarSchema, gateRequestRaw);
      const expectedSnapshotDir = join(trialDir, WORKSPACE_SNAPSHOT_DIR);
      let snapshotDir: string | null = null;
      if (
        gateRequest !== null &&
        gateRequest.trialName === entry &&
        gateRequest.arm === expectedArm
      ) {
        try {
          if (realpathSync(gateRequest.snapshotDir) === realpathSync(expectedSnapshotDir)) {
            snapshotDir = gateRequest.snapshotDir;
          }
        } catch {
          snapshotDir = null;
        }
      }
      const respond = async (): Promise<void> => {
        try {
          await this.answerGateRequest(trialDir, verdictPath, snapshotDir, gateDecider);
        } finally {
          inFlight.delete(trialDir);
        }
      };
      inFlight.set(trialDir, respond());
    }
  }

  /**
   * Answers one gate request exactly once. The verdict is written ATOMICALLY
   * (temp file + rename) so the bridge never observes a torn verdict.
   */
  private async answerGateRequest(
    trialDir: string,
    verdictPath: string,
    snapshotDir: string | null,
    gateDecider: GateDecider | undefined,
  ): Promise<void> {
    const writeVerdictAtomic = (payload: Record<string, unknown>): void => {
      const tmpPath = `${verdictPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
      renameSync(tmpPath, verdictPath);
    };
    if (!snapshotDir || !existsSync(snapshotDir)) {
      // Fail-closed fast: undecidable snapshot blocks the trial.
      writeVerdictAtomic({
        verdict: "BLOCK",
        failureReasons: [`Gate snapshot unavailable: "${snapshotDir}".`],
        checks: [],
        evaluatedAt: new Date().toISOString(),
        gateId: "session-guard",
        snapshotHash: null,
      });
      return;
    }
    // Pre-gate hash: the verdict binds the exact bytes the gate observed.
    // The slice re-verifies seal equality (TOCTOU guard).
    let preGateHash: string | null = null;
    try {
      assertNoSpecialFiles(snapshotDir);
      preGateHash = computeTaskChecksum(snapshotDir);
    } catch (err) {
      writeVerdictAtomic({
        verdict: "BLOCK",
        failureReasons: [`Gate snapshot unsealable: ${err instanceof Error ? err.message : String(err)}.`],
        checks: [],
        evaluatedAt: new Date().toISOString(),
        gateId: "session-guard",
        snapshotHash: null,
      });
      return;
    }
    // Read-only gate window: a writing gate fails fast (EACCES) instead
    // of silently mutating the evidence the seal will cover.
    makeReadOnlyRecursive(snapshotDir);
    try {
      if (!gateDecider) {
        throw new Error("No gateDecider for a live gate request.");
      }
      const decision = await gateDecider(snapshotDir);
      writeVerdictAtomic({
        verdict: decision.verdict,
        failureReasons: decision.failureReasons ?? [],
        checks: decision.checks,
        evaluatedAt: new Date().toISOString(),
        gateId: decision.gateId,
        snapshotHash: preGateHash,
      });
    } catch (err) {
      // Decider errors fail closed fast (never leave the bridge hanging
      // until its own timeout, never silently pass).
      writeVerdictAtomic({
        verdict: "BLOCK",
        failureReasons: [`Gate decider failed: ${err instanceof Error ? err.message : String(err)}.`],
        checks: [],
        evaluatedAt: new Date().toISOString(),
        gateId: "session-guard",
        snapshotHash: preGateHash,
      });
    } finally {
      try {
        makeWritableRecursive(snapshotDir);
      } catch {
        // best-effort restore
      }
    }
  }

  private assertNoUnansweredRequests(targetJobDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(targetJobDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const trialDir = join(targetJobDir, entry);
      if (existsSync(join(trialDir, GATE_REQUEST_FILE)) && !existsSync(join(trialDir, GATE_VERDICT_FILE))) {
        throw new ActionableBenchmarkError({
          code: "HARNESS_UNAVAILABLE",
          message: `Unanswered gate request in "${trialDir}": the bridge died awaiting a verdict.`,
          remediation: "Inspect bridge logs; fail-closed, never silently pass blocked trials.",
          retryable: false,
        });
      }
    }
  }

  private readVersionFile(jobDirectory: string): { version: string | null; source: "importlib" | "help-text" | "unresolved" } {
    const versionPath = join(jobDirectory, HARBOR_VERSION_FILE);
    if (!existsSync(versionPath)) return { version: null, source: "unresolved" };
    try {
      const parsed = readJsonFile(versionPath) as { version?: unknown; source?: unknown };
      if (typeof parsed.version === "string" && /^\d+\.\d+\.\d+$/.test(parsed.version)) {
        return { version: parsed.version, source: parsed.source === "importlib" ? "importlib" : "unresolved" };
      }
      return { version: null, source: "unresolved" };
    } catch {
      return { version: null, source: "unresolved" };
    }
  }

  private readNativeTrial(
    resultPath: string,
    request: HarborSessionRequest,
    _distribution: HarborDistributionAttestation,
  ): HarborSessionTrialNative {
    const rawBytes = readFileSync(resultPath, "utf8");
    const trial = harborTrialResultSchema.parse(JSON.parse(rawBytes));
    const trialResultHash = createHash("sha256").update(rawBytes).digest("hex");
    const trialDir = dirname(resultPath);

    const readSidecar = (name: string): unknown | null => {
      const p = join(trialDir, name);
      if (!existsSync(p)) return null;
      try {
        return readJsonFile(p);
      } catch {
        return { __unparseable: true, file: name };
      }
    };

    const claimRaw = readSidecar(CLAIM_FILE);
    const outcomeRaw = readSidecar(AGENT_OUTCOME_FILE);
    const identityRaw = readSidecar(CONTAINER_IDENTITY_FILE);
    const exportRaw = readSidecar(EXPORT_MANIFEST_FILE);
    const verdictRaw = readSidecar(GATE_VERDICT_FILE);
    const recoveryRaw = readSidecar("recovery-events.json");
    const recoveryEvents = parseSidecar(recoveryEventsSidecarSchema, recoveryRaw);
    if (recoveryRaw !== null && recoveryEvents === null) {
      throw new ActionableBenchmarkError({ code: "RESULT_INVALID", message: "Malformed recovery-events.json cannot be trusted", remediation: "Persist an ordered BLOCK→retry→PASS or exhausted history.", retryable: false });
    }
    const blockedRaw = readSidecar(GATE_BLOCKED_FILE);
    const gateRequestPath = join(trialDir, GATE_REQUEST_FILE);
    const gateRequestRaw = readSidecar(GATE_REQUEST_FILE);
    const parsedGateRequest = parseSidecar(gateRequestSidecarSchema, gateRequestRaw);
    let gateRequested = false;
    if (existsSync(gateRequestPath)) {
      const expectedSnapshotDir = join(trialDir, WORKSPACE_SNAPSHOT_DIR);
      let snapshotMatches = false;
      try {
        snapshotMatches =
          parsedGateRequest !== null &&
          realpathSync(parsedGateRequest.snapshotDir) === realpathSync(expectedSnapshotDir);
      } catch {
        snapshotMatches = false;
      }
      if (
        parsedGateRequest === null ||
        parsedGateRequest.trialName !== trial.trial_name ||
        parsedGateRequest.arm !== request.arm ||
        !snapshotMatches
      ) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Bridge sidecar rejected: ${GATE_REQUEST_FILE} is malformed or not exactly bound to trial "${trial.trial_name}", arm "${request.arm}" and its workspace snapshot.`,
          remediation: "Gate requests must name the native trial and arm and reference exactly trialDir/workspace-snapshot.",
          retryable: false,
        });
      }
      gateRequested = true;
    }

    // Strict claim/outcome parsing happens below (single definition).
    const exceptionType =
      trial.exception_info && typeof trial.exception_info === "object"
        ? (trial.exception_info as { exception_type?: unknown }).exception_type
        : null;

    const verifierPresent = trial.verifier !== null && trial.verifier !== undefined;
    // Strict A2 prevention proof (R8 item 2): exact exception type, parsed
    // marker with exact trial name and internal BLOCK, corroborating BLOCK
    // verdict. Substring matches and unread markers never count.
    const gateBlockProof = isProvenGateBlock({
      trialName: trial.trial_name,
      exceptionType,
      blockedRaw,
      verdictRaw,
    });
    const gateBlocked = gateBlockProof.proven;
    if (request.arm === "A3_recovering" && gateBlocked && recoveryEvents === null) {
      throw new ActionableBenchmarkError({ code: "RESULT_INVALID", message: "A3 BLOCK lacks a recovery history", remediation: "Persist recovery-events.json for every A3 BLOCK before recording exhaustion.", retryable: false });
    }
    const parsedGateVerdict = parseSidecar(gateVerdictSidecarSchema, verdictRaw);
    if (request.arm === "A3_recovering" && parsedGateVerdict !== null) {
      const terminal = recoveryEvents?.[recoveryEvents.length - 1];
      if (parsedGateVerdict.verdict === "PASS" && (!terminal || terminal.action !== "continue" || terminal.gateVerdict !== "PASS")) throw new ActionableBenchmarkError({ code: "RESULT_INVALID", message: "A3 PASS lacks terminal recovery evidence", remediation: "Persist a terminal PASS/continue event.", retryable: false });
      if (parsedGateVerdict.verdict === "BLOCK" && (!terminal || terminal.action !== "exhausted" || terminal.gateVerdict !== "BLOCK" || recoveryEvents.length !== 4)) throw new ActionableBenchmarkError({ code: "RESULT_INVALID", message: "A3 BLOCK lacks complete exhaustion evidence", remediation: "Persist three retries followed by exhausted/BLOCK.", retryable: false });
    }

    const criterionKeyMatch = request.successCriterion.trim().match(/^([a-zA-Z0-9_-]+)/);
    const targetRewardKey = criterionKeyMatch ? criterionKeyMatch[1]! : "reward";
    // Trials whose verifier never ran (blocked/errored) carry no rewards;
    // they are recorded as unevaluated, never as passed.
    const observedRewards = trial.verifier_result?.rewards;
    const actualReward = observedRewards !== undefined && observedRewards !== null
      ? (observedRewards[targetRewardKey] ?? Object.values(observedRewards)[0] ?? 0)
      : 0;
    const passed = observedRewards !== undefined && observedRewards !== null
      ? evaluateSuccessCriterion(observedRewards, request.successCriterion)
      : false;
    const verifierOutputHash = sha256HexSchema.parse(
      createHash("sha256").update(JSON.stringify(trial.verifier_result)).digest("hex"),
    );
    const verifierDurationMs = trial.verifier
      ? Math.max(0, new Date(trial.verifier.finished_at).getTime() - new Date(trial.verifier.started_at).getTime())
      : 0;

    const trialTaskPath =
      typeof trial.task_id === "object" && trial.task_id && "path" in trial.task_id
        ? (trial.task_id as { path: string }).path
        : trial.task_name;
    const trialConfig = trial.config as unknown as Record<string, unknown>;
    const trialAgent = trialConfig["agent"] as Record<string, unknown> | undefined;

    const agentStartedAt =
      trial.agent_execution?.started_at ?? trial.started_at ?? new Date(0).toISOString();

    // Strict claim rule (R8 item 1): a claim is valid only for an exact
    // trialName, literal declaredDone:true and a valid ISO timestamp — AND
    // only when no outcome file coexists (mutual exclusivity). Anything else
    // is absence, which downstream paths quarantine instead of trusting.
    const parsedClaim = parseSidecar(claimSidecarSchema, claimRaw);
    const parsedOutcome = parseSidecar(outcomeSidecarSchema, outcomeRaw);
    const claimValid =
      parsedClaim !== null &&
      parsedClaim.trialName === trial.trial_name &&
      outcomeRaw === null;
    const outcomeValid =
      parsedOutcome !== null &&
      parsedOutcome.trialName === trial.trial_name &&
      !claimValid && claimRaw === null;
    // Note: when both files exist (even if one is malformed), neither is
    // trusted: claimValid requires outcome absence and outcomeValid requires
    // claim absence.
    const observedModelName =
      typeof trial.agent_info?.model_info?.name === "string"
        ? (trial.agent_info.model_info.name as string)
        : null;
    const observedModelProvider =
      typeof trial.agent_info?.model_info?.provider === "string"
        ? (trial.agent_info.model_info.provider as string)
        : null;
    const configuredModelName =
      typeof trialAgent?.["model_name"] === "string"
        ? (trialAgent["model_name"] as string)
        : null;
    const modelName =
      observedModelName !== null &&
      observedModelProvider !== null &&
      configuredModelName === `${observedModelProvider}/${observedModelName}`
        ? configuredModelName
        : observedModelName ?? configuredModelName;

    return {
      harborJobId: (trialConfig["job_id"] as string) ?? "",
      harborTrialId: trial.id,
      harborTrialName: trial.trial_name,
      trialDirectory: trialDir,
      trialResultPath: resultPath,
      trialResultHash,
      claimPresent: claimValid,
      claimTimestamp: claimValid && parsedClaim ? parsedClaim.observedAt : null,
      agentOutcome: outcomeValid && parsedOutcome
        ? {
            declaredDone: false,
            reason: parsedOutcome.reason,
            message: parsedOutcome.message,
            observedAt: parsedOutcome.observedAt,
          }
        : null,
      agentStartedAt,
      agentName: trial.agent_info?.name ?? "",
      modelName,
      taskName: trial.task_name,
      taskPath: trialTaskPath,
      taskChecksum: trial.task_checksum,
      trialUri: trial.trial_uri,
      reward: actualReward,
      passed,
      verifierPresent,
      gateBlocked,
      verifierDurationMs,
      verifierOutputHash,
      inputTokens: trial.agent_result?.n_input_tokens ?? null,
      outputTokens: trial.agent_result?.n_output_tokens ?? null,
      costUsd: trial.agent_result?.cost_usd ?? null,
      promptTokensAtClaim: trial.agent_result?.n_input_tokens ?? null,
      snapshotDir: join(trialDir, WORKSPACE_SNAPSHOT_DIR),
      exportedPaths: (() => {
        const parsed = parseSidecar(exportManifestSidecarSchema, exportRaw);
        return parsed !== null ? [...parsed.exported] : [];
      })(),
      gateRequested,
      gateVerdictObserved: (() => {
        const parsed = parseSidecar(gateVerdictSidecarSchema, verdictRaw);
        return parsed !== null ? parsed.verdict : null;
      })(),
      gateEvaluatedAt: (() => {
        const parsed = parseSidecar(gateVerdictSidecarSchema, verdictRaw);
        return parsed !== null ? parsed.evaluatedAt : null;
      })(),
      gateSnapshotHash: (() => {
        const parsed = parseSidecar(gateVerdictSidecarSchema, verdictRaw);
        return parsed !== null ? parsed.snapshotHash : null;
      })(),
      gateId: (() => {
        const parsed = parseSidecar(gateVerdictSidecarSchema, verdictRaw);
        return parsed !== null ? parsed.gateId : null;
      })(),
      gateFailureReasons: (() => {
        const parsed = parseSidecar(gateVerdictSidecarSchema, verdictRaw);
        return parsed !== null ? [...parsed.failureReasons] : [];
      })(),
      gateChecks: (() => {
        const parsed = parseSidecar(gateVerdictSidecarSchema, verdictRaw);
        return parsed !== null ? parsed.checks.map((check) => ({ ...check, evidence: [...check.evidence] })) : [];
      })(),
      containerId: (() => {
        const parsed = parseSidecar(containerIdentitySidecarSchema, identityRaw);
        return parsed !== null ? parsed.containerId : "";
      })(),
      containerDigestEffective: (() => {
        const parsed = parseSidecar(containerIdentitySidecarSchema, identityRaw);
        if (parsed === null) return "";
        const repo = parsed.repoDigests.find((d) => /^sha256:[0-9a-f]{64}$/i.test(d));
        return repo ?? parsed.imageId;
      })(),
      containerImageRef: (() => {
        const parsed = parseSidecar(containerIdentitySidecarSchema, identityRaw);
        return parsed !== null ? parsed.imageRef : null;
      })(),
      containerRepoDigests: (() => {
        const parsed = parseSidecar(containerIdentitySidecarSchema, identityRaw);
        return parsed !== null ? [...parsed.repoDigests] : [];
      })(),
      recoveryAttempts: (recoveryEvents ?? []).filter((event) => event.action === "retry").length,
      recoverySuccessful: deriveRecoverySuccessful(
        request.arm,
        (recoveryEvents ?? []).filter((event) => event.action === "retry").length,
        verifierPresent ? passed : null,
      ),
    };
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export { PINNED_HARBOR_VERSION };
