import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import yaml from "yaml";
import {
  CompletionGate,
  LocalCommandExecutor,
  type GateEvaluationInput,
  type GateEvaluationResult,
  type ICompletionGate,
} from "@shokunin/core";
import type {
  BenchmarkTrialArm,
  BenchmarkTrial,
  BenchmarkTrialStopReason,
  CompletionClaim,
  CompletionClaimVerdict,
  BenchmarkTrialVerifier,
  TrialFailureClassification,
} from "../../contracts/trial.contract.js";
import {
  benchmarkTrialSchema,
  sha256HexSchema,
  ociDigestSchema,
} from "../../schemas/trial.schema.js";
import type { HarborJobRequest } from "../../contracts/harbor.contract.js";
import { NDJsonStore } from "../persistence/ndjson-store.js";
import { SessionLedger } from "../persistence/session-ledger.js";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";
import { computeTaskChecksum } from "../crypto/dirhash.js";
import {
  assertNoSpecialFiles,
  makeReadOnlyRecursive,
  makeWritableRecursive,
  removeDirBestEffort,
  snapshotFileBytes,
} from "../snapshots/snapshot-fs.js";
import type {
  HarborSessionJob,
  HarborSessionTrialNative,
  IPhasedHarborSession,
  RuntimeClaimEvent,
  RuntimeEventLog,
  RuntimeEventRecord,
  RuntimePhaseEvent,
  SealedSnapshotRef,
} from "../../contracts/runtime-protocol.contract.js";

export const BRIDGE_AGENT_NAME = "shokunin-intercept";
export { makeWritableRecursive, makeReadOnlyRecursive, assertNoSpecialFiles } from "../snapshots/snapshot-fs.js";
export const BRIDGE_IMPORT_PATH = "shokunin_intercept_agent:ShokuninInterceptAgent";

export interface VerticalSliceOptions {
  readonly trialId: string;
  readonly arm: BenchmarkTrialArm;
  readonly task: {
    readonly taskId: string;
    readonly taskName: string;
    readonly taskChecksum: string;
    readonly benchmarkVersion: string;
  };
  readonly agent: {
    readonly agentName: string;
    readonly modelName: string;
    readonly promptPath?: string | undefined;
    readonly promptContent?: string | undefined;
  };
  readonly gateInput?: GateEvaluationInput | undefined;
  readonly harborRequest: HarborJobRequest;
  readonly ndjsonPath: string;
  readonly completionGate?: ICompletionGate | undefined;
  /**
   * R6 in-runtime interception session (REQUIRED, no default): the lab-owned
   * bridge agent runs inside the Harbor trial; this slice only serves gate
   * verdicts and records. The R5 dual-runner and post-hoc reconstruction are gone.
   */
  readonly harborSession: IPhasedHarborSession;
  /**
   * Lab-pinned expected container digest (image ID or RepoDigest). The bridge
   * enforces it live; this slice re-checks defense-in-depth and quarantines
   * on drift. REQUIRED: unpinned runs are not evidence-grade.
   */
  readonly expectedContainerDigest: string;
  readonly experimentId: string;
  readonly campaignId: string;
  readonly hypothesisId: string;
  readonly repetitionIndex: number;
  readonly runtimeId: string;
  readonly runtimeVersion: string;
  readonly modelTemperature?: number | null | undefined;
}

export interface VerticalSliceResult {
  /** ALL persisted trials, in Harbor trial order. N executed === N records. */
  readonly trials: readonly BenchmarkTrial[];
  /** Primary trial (first) — backwards compatibility. */
  readonly trial: BenchmarkTrial;
  /** Per-trial event logs, index-aligned with `trials`. */
  readonly eventLogs: readonly RuntimeEventLog[];
  /** Primary event log — backwards compatibility. */
  readonly eventLog: RuntimeEventLog;
  /** Per-trial sealed snapshots, index-aligned with `trials`. */
  readonly snapshotRefs: readonly SealedSnapshotRef[];
  /** Primary snapshot store path (persistent, read-only). */
  readonly snapshotDirectory?: string | undefined;
  /** Per-trial gate results (undefined for A0), index-aligned. */
  readonly gateResults: readonly (GateEvaluationResult | undefined)[];
  /** Primary gate result — backwards compatibility. */
  readonly gateResult?: GateEvaluationResult | undefined;
  /** Durable session ledger path (job STARTED + per-trial terminals). */
  readonly ledgerPath: string;
}

function failConfig(message: string, remediation: string, details?: Record<string, unknown>): never {
  throw new ActionableBenchmarkError({
    code: "CONFIG_INVALID",
    message,
    remediation,
    retryable: false,
    ...(details ? { details } : {}),
  });
}

function failResult(message: string, remediation: string, details?: Record<string, unknown>): never {
  throw new ActionableBenchmarkError({
    code: "RESULT_INVALID",
    message,
    remediation,
    retryable: false,
    ...(details ? { details } : {}),
  });
}

function assertMonotonic(log: RuntimeEventRecord[]): void {
  for (let i = 1; i < log.length; i++) {
    const prev = new Date(log[i - 1]!.timestamp).getTime();
    const cur = new Date(log[i]!.timestamp).getTime();
    if (Number.isNaN(prev) || Number.isNaN(cur) || cur < prev) {
      failResult(
        `Causal event order violated: "${log[i - 1]!.event}" (${log[i - 1]!.timestamp}) precedes "${log[i]!.event}" (${log[i]!.timestamp}).`,
        "Ensure the session emits monotonically increasing timestamps per trial.",
        { eventLog: log },
      );
    }
  }
}

function assertTerminalEvent(log: RuntimeEventRecord[], expected: "verifier_finished" | "trial_blocked" | "verifier_skipped"): void {
  const last = log[log.length - 1]!.event;
  if (last !== expected) {
    failResult(
      `Fictitious terminal event: trial ends with "${last}" instead of "${expected}". verifier_finished without a persisted verifier is forbidden.`,
      "Emit verifier_finished exactly when a verifier result is persisted, trial_blocked for gate-blocked trials, verifier_skipped for untrusted trials.",
    );
  }
}

function validateClaimTimestamp(observedAt: string | null, trialName: string): string {
  if (typeof observedAt !== "string" || Number.isNaN(new Date(observedAt).getTime())) {
    failResult(
      `Bridge claim rejected for trial "${trialName}": observedAt must be a valid ISO datetime of the observed clean return.`,
      "The bridge records the observed clean-return timestamp; finished_at is never coerced.",
    );
  }
  return observedAt as string;
}

interface PromptEvidence {
  readonly promptHash: string;
  readonly promptBytes: Buffer;
  readonly promptOrigin: string;
  readonly manifestHash: string;
}

interface ManifestBinding {
  readonly manifestBytes: Buffer;
  readonly bridgeAgentName: string;
  readonly bridgeImportPath: string;
  readonly bridgeModelName: string;
  readonly bridgeInnerAgent: string;
  readonly bridgeArm: string;
  readonly bridgeExpectedDigest: string | null;
}

/**
 * Executes the in-runtime interception slice (ZB2.2-R6):
 * exactly ONE Harbor session whose trials carry the bridge agent; per native
 * trial: agent_started → native_completion_claim → snapshot_sealed →
 * gate_evaluated → verifier_finished | trial_blocked | verifier_skipped.
 * Every trial — success, evaluated failure, blocked, corrupt, timeout, error —
 * yields exactly one incrementally persisted record plus a ledger terminal, so
 * late exceptions lose nothing already built.
 */
export async function executeVerticalSlice(
  options: VerticalSliceOptions,
): Promise<VerticalSliceResult> {
  const startTime = Date.now();
  const tempDirs: string[] = [];
  let lastFailureSnapshot: SealedSnapshotRef | null = null;
  const readFailureSnapshot = (): SealedSnapshotRef => {
    if (!lastFailureSnapshot) {
      failResult("Failure snapshot unavailable.", "Seal the failure context before referencing it.");
    }
    return lastFailureSnapshot!;
  };
  const cleanupTemp = (): void => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      removeDirBestEffort(dir);
    }
  };

  const ledgerPath = join(resolve(dirname(options.ndjsonPath)), "session-ledger.jsonl");
  const ledger = new SessionLedger();
  const store = new NDJsonStore<BenchmarkTrial>(benchmarkTrialSchema, {
    idOf: (record: BenchmarkTrial) => record.trialId,
  });
  const ledgerTerminal = async (
    event: "TRIAL_COMPLETED" | "TRIAL_BLOCKED" | "TRIAL_QUARANTINED" | "TRIAL_FAILED",
    trialId: string,
    detail?: Record<string, unknown>,
  ): Promise<void> => {
    await ledger.append(ledgerPath, {
      event,
      scope: "trial",
      jobName: options.harborRequest.expectedJobName,
      trialId,
      timestamp: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    });
  };

  try {
    // 0. Fail-closed arm + mandatory provenance (zero constants).
    const requiredStrings: Record<string, unknown> = {
      experimentId: options.experimentId,
      campaignId: options.campaignId,
      hypothesisId: options.hypothesisId,
      runtimeId: options.runtimeId,
      runtimeVersion: options.runtimeVersion,
      "task.taskId": options.task.taskId,
      "task.taskName": options.task.taskName,
      "task.taskChecksum": options.task.taskChecksum,
      "task.benchmarkVersion": options.task.benchmarkVersion,
      "agent.agentName": options.agent.agentName,
      "agent.modelName": options.agent.modelName,
      trialId: options.trialId,
    };
    for (const [key, value] of Object.entries(requiredStrings)) {
      if (typeof value !== "string" || value.trim().length === 0) {
        failConfig(
          `Missing mandatory provenance: "${key}" must be a non-empty string. Synthetic fallback constants are prohibited (UNBOUND_PROVENANCE).`,
          `Provide explicit ${key} from the real execution/manifest.`,
          { key },
        );
      }
    }
    if (
      typeof options.repetitionIndex !== "number" ||
      !Number.isInteger(options.repetitionIndex) ||
      options.repetitionIndex < 0
    ) {
      failConfig(
        "Missing mandatory provenance: repetitionIndex must be a non-negative integer.",
        "Provide repetitionIndex from the experiment manifest.",
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(options.task.taskChecksum)) {
      failConfig(
        `Invalid taskChecksum "${options.task.taskChecksum}": must be a 64-character hex SHA-256.`,
        "Provide the authentic computed checksum of the task.",
      );
    }
    ociDigestSchema.parse(options.expectedContainerDigest);
    if (!options.harborSession || typeof options.harborSession.executeSession !== "function") {
      failConfig(
        "harborSession is required: interception sessions are the only runtime (post-hoc reconstruction removed in R6).",
        "Provide an IPhasedHarborSession (production HarborBridgeSession).",
      );
    }

    // 1. Manifest must exist; derive authentic configHash + bridge binding.
    // The manifest agent MUST be the lab-owned bridge (auditable import_path);
    // options bind to its declared inner agent/arm/digest, never float free.
    if (!existsSync(options.harborRequest.jobConfigPath)) {
      failConfig(
        `Job config file not found: "${options.harborRequest.jobConfigPath}"`,
        "Ensure harborRequest.jobConfigPath exists on disk.",
      );
    }
    const manifestBytes = readFileSync(options.harborRequest.jobConfigPath);
    const manifest = readManifestBinding(manifestBytes);
    if (manifest.bridgeAgentName !== BRIDGE_AGENT_NAME) {
      failConfig(
        `Manifest agent "${manifest.bridgeAgentName}" is not the interception bridge "${BRIDGE_AGENT_NAME}".`,
        "Author experiment manifests with the lab-owned bridge agent (import_path auditable).",
      );
    }
    if (manifest.bridgeImportPath !== BRIDGE_IMPORT_PATH) {
      failConfig(
        `Manifest import_path "${manifest.bridgeImportPath}" is not the laboratory bridge "${BRIDGE_IMPORT_PATH}".`,
        "Only the lab-owned bridge module may intercept trials.",
      );
    }
    if (manifest.bridgeModelName !== options.agent.modelName) {
      failConfig(
        `Unbound model identity: options model "${options.agent.modelName}" contradicts manifest model "${manifest.bridgeModelName}".`,
        "Align options.agent.modelName with the manifest-declared model.",
      );
    }
    if (manifest.bridgeInnerAgent !== options.agent.agentName) {
      failConfig(
        `Unbound agent identity: options agent "${options.agent.agentName}" contradicts manifest inner agent "${manifest.bridgeInnerAgent}".`,
        "Align options.agent.agentName with the bridge-declared inner agent.",
      );
    }
    if (manifest.bridgeArm !== options.arm) {
      failConfig(
        `Unbound arm: options arm "${options.arm}" contradicts manifest arm "${manifest.bridgeArm}".`,
        "Align options.arm with the bridge-declared arm.",
      );
    }
    if (manifest.bridgeExpectedDigest !== null && manifest.bridgeExpectedDigest.toLowerCase() !== options.expectedContainerDigest.toLowerCase()) {
      failConfig(
        "Unbound digest pin: manifest kwargs digest differs from the options pin.",
        "Align the manifest kwargs digest with the experiment pin.",
      );
    }
    const configHash = sha256HexSchema.parse(createHash("sha256").update(manifestBytes).digest("hex"));

    // 2. Prompt bytes ONLY (bare hashes rejected).
    const prompt: PromptEvidence = {
      ...readPromptEvidence(options),
      manifestHash: sha256HexSchema.parse(createHash("sha256").update(manifestBytes).digest("hex")),
    };

    // 3. Gate decider closure: served LIVE by the session while containers
    // run. The verdict (with gate-time snapshot hash) is written into the
    // trial dir; the slice later re-verifies seal equality (TOCTOU guard).
    const gate = options.completionGate ?? new CompletionGate(new LocalCommandExecutor());
    const gateDecider =
      options.arm === "A0_baseline"
        ? undefined
        : async (snapshotDir: string) => {
            if (!options.gateInput) {
              failConfig(`gateInput is required for arm "${options.arm}".`, "Provide gateInput with declared checks.");
            }
            const evaluated = await gate.evaluate({ ...options.gateInput, evidenceRoot: snapshotDir });
            return {
              verdict: (evaluated.verdict === "PASS" ? "PASS" : "BLOCK") as "PASS" | "BLOCK",
              failureReasons: evaluated.checks
                .filter((c) => c.verdict === "FAIL")
                .map((c) => [c.message, ...c.evidence].filter(Boolean).join("\n")),
              checks: evaluated.checks.map((check) => ({
                id: check.id,
                verdict: check.verdict,
                evidence: [...check.evidence],
                message: check.message,
              })),
              gateId: options.gateInput.gateId,
            };
          };

    // 4. SINGLE interception session. No second agent execution exists.
    let sessionJob: HarborSessionJob;
    try {
      sessionJob = await options.harborSession.executeSession({
        jobConfigPath: options.harborRequest.jobConfigPath,
        jobsRoot: options.harborRequest.jobsRoot,
        expectedJobName: options.harborRequest.expectedJobName,
        timeoutMs: options.harborRequest.timeoutMs,
        successCriterion: options.harborRequest.successCriterion,
        expectedTaskChecksum: options.task.taskChecksum,
        ...((options.harborRequest as { taskDirectory?: string }).taskDirectory
          ? { taskDirectory: (options.harborRequest as { taskDirectory?: string }).taskDirectory! }
          : {}),
        arm: options.arm,
        ...(gateDecider ? { gateDecider } : {}),
        ledgerPath,
        expectedContainerDigest: options.expectedContainerDigest,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failure = buildJobFailureRecord(
        options, manifest, prompt, configHash, null, startTime, err,
        // Zero executed trials is a harness-side anomaly, not a verdict.
        /Zero-trial job rejected/.test(message) ? "EXOGENOUS_INFRASTRUCTURE_FAILURE" : undefined,
      );
      await store.append(options.ndjsonPath, failure);
      await ledgerTerminal("TRIAL_FAILED", failure.trialId, { phase: "session" });
      throw err;
    }

    if (sessionJob.trials.length === 0) {
      const failure = buildJobFailureRecord(
        options, manifest, prompt, configHash, sessionJob, startTime,
        new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: "Harbor session returned zero trials. Cannot construct BenchmarkTrial records.",
          remediation: "Ensure the session executes at least one evaluated trial.",
          retryable: false,
        }),
        "EXOGENOUS_INFRASTRUCTURE_FAILURE",
      );
      await store.append(options.ndjsonPath, failure);
      await ledgerTerminal("TRIAL_FAILED", failure.trialId, { phase: "zero-trials" });
      failResult("Harbor session returned zero trials. A failure record was persisted; no silent loss.", "Ensure the session executes at least one evaluated trial.");
    }

    // 5. Per-trial records with INCREMENTAL persistence: each built record is
    // appended (locked) plus its ledger terminal before the next trial, so a
    // late exception loses nothing already built (R5 review P0).
    const trials: BenchmarkTrial[] = [];
    const eventLogs: RuntimeEventLog[] = [];
    const snapshotRefs: SealedSnapshotRef[] = [];
    const gateResults: (GateEvaluationResult | undefined)[] = [];
    const totalTrials = sessionJob.trials.length;

    for (const native of sessionJob.trials) {
      try {
        const built = await buildTrialRecord(options, manifest, prompt, configHash, sessionJob, native, totalTrials, startTime);
        await store.append(options.ndjsonPath, built.trial);
        await ledgerTerminal(
          built.blocked ? "TRIAL_BLOCKED" : "TRIAL_COMPLETED",
          built.trial.trialId,
          { nativeTrialId: native.harborTrialId },
        );
        trials.push(built.trial);
        eventLogs.push(built.eventLog);
        snapshotRefs.push(built.snapshotRef);
        gateResults.push(built.gateResult);
      } catch (err) {
        if (err instanceof ActionableBenchmarkError) {
          const quarantined = buildCorruptTrialRecord(options, manifest, prompt, configHash, sessionJob, native, totalTrials, startTime, err);
          await store.append(options.ndjsonPath, quarantined.trial);
          await ledgerTerminal("TRIAL_QUARANTINED", quarantined.trial.trialId, { reason: err.code });
          trials.push(quarantined.trial);
          eventLogs.push(quarantined.eventLog);
          snapshotRefs.push(quarantined.snapshotRef);
          gateResults.push(undefined);
          continue;
        }
        await ledgerTerminal("TRIAL_FAILED", `${options.trialId}__${native.harborTrialName}`, { phase: "build", fatal: true });
        throw err;
      }
    }

    const primary = trials[0]!;
    return {
      trials,
      trial: primary,
      eventLogs,
      eventLog: eventLogs[0]!,
      snapshotRefs,
      snapshotDirectory: snapshotRefs[0]!.storePath,
      gateResults,
      gateResult: gateResults[0],
      ledgerPath,
    };
  } finally {
    cleanupTemp();
  }

  // ---- local builders (closures over tempDirs) ----

  async function buildTrialRecord(
    opts: VerticalSliceOptions,
    man: ManifestBinding,
    pr: PromptEvidence,
    cfgHash: string,
    job: HarborSessionJob,
    native: HarborSessionTrialNative,
    totalTrials: number,
    sliceStart: number,
  ): Promise<{ trial: BenchmarkTrial; eventLog: RuntimeEventLog; snapshotRef: SealedSnapshotRef; gateResult: GateEvaluationResult | undefined; blocked: boolean }> {
    const log: RuntimeEventRecord[] = [];
    const push = (event: RuntimePhaseEvent, timestamp: string): void => {
      log.push({ event, timestamp });
    };

    // Trial→options binding (R6 item: nothing scientific from options alone).
    if (native.taskChecksum.toLowerCase() !== opts.task.taskChecksum.toLowerCase()) {
      failResult(`Trial task_checksum "${native.taskChecksum}" contradicts experiment task "${opts.task.taskChecksum}".`, "Ensure the executed trial evaluates the experiment task.");
    }
    if (native.taskName !== opts.task.taskName) {
      failResult(`Trial task_name "${native.taskName}" contradicts experiment task "${opts.task.taskName}".`, "Ensure trial task identity exactly matches the experiment task.");
    }
    const expectedTaskPath = opts.harborRequest.taskDirectory
      ? resolve(opts.harborRequest.taskDirectory)
      : opts.task.taskName;
    const nativeTaskPath = opts.harborRequest.taskDirectory
      ? resolve(native.taskPath)
      : native.taskPath;
    if (nativeTaskPath !== expectedTaskPath) {
      failResult(
        `Trial task path "${native.taskPath}" contradicts executed task path "${expectedTaskPath}".`,
        "Bind the native Harbor task path exactly to harborRequest.taskDirectory (or taskName when no directory is declared).",
      );
    }
    if (native.agentName !== opts.agent.agentName) {
      failResult(`Trial agent "${native.agentName}" contradicts experiment agent "${opts.agent.agentName}".`, "Ensure the executed trial agent matches the experiment agent.");
    }
    if (native.modelName !== null && native.modelName !== opts.agent.modelName) {
      failResult(`Trial model "${native.modelName}" contradicts experiment model "${opts.agent.modelName}".`, "Ensure the executed trial model matches the experiment model.");
    }
    // Digest defense-in-depth: bridge enforced live; re-check returned facts.
    if (!digestMatchesPin(native, opts.expectedContainerDigest)) {
      failResult(
        `Container digest drift: live container "${native.containerDigestEffective}" does not match lab pin "${opts.expectedContainerDigest}".`,
        "The bridge must fail closed on drift; quarantine records the inconsistency instead of trusting it.",
        { effective: native.containerDigestEffective, pin: opts.expectedContainerDigest },
      );
    }

    push("agent_started", native.agentStartedAt);

    // Claim rule (R6 item 2): claim.json (clean native return) is the ONLY
    // claim source. Timeouts/errors carry agent-outcome.json and NO claim;
    // finished_at is a timing and is never coerced into declaredDone:true.
    let claimed = false;
    let claimTimestamp = native.agentStartedAt;
    let stopReason: BenchmarkTrialStopReason;
    if (native.claimPresent) {
      claimTimestamp = validateClaimTimestamp(native.claimTimestamp, native.harborTrialName);
      push("native_completion_claim", claimTimestamp);
      claimed = true;
      stopReason = "agent_declared_done";
    } else if (native.agentOutcome !== null && native.agentOutcome.reason === "agent_timeout") {
      stopReason = "timeout";
    } else if (native.agentOutcome !== null) {
      stopReason = "error";
    } else {
      failResult(
        `Trial "${native.harborTrialName}" carries neither claim.json nor agent-outcome.json: the bridge breached protocol without explanation.`,
        "Every trial must end with a claim (clean return) or an outcome marker (timeout/error).",
      );
    }
    assertMonotonic([...log]);

    // Snapshot the BRIDGE-EXPORTED pre-verifier workspace (live container
    // bytes), never the Harbor logs/results directory (R5 review P0).
    if (!existsSync(native.snapshotDir)) {
      failResult(`Native workspace snapshot missing for trial "${native.harborTrialName}": "${native.snapshotDir}".`, "The bridge must export the container workspace pre-verifier.");
    }
    assertNoSpecialFiles(native.snapshotDir);
    const tempSnapshotDir = mkdtempSync(join(tmpdir(), `harbor-snapshot-${opts.trialId}-${native.harborTrialName}-`));
    tempDirs.push(tempSnapshotDir);
    cpSync(native.snapshotDir, tempSnapshotDir, { recursive: true });
    assertNoSpecialFiles(tempSnapshotDir);
    const snapshotId = sha256HexSchema.parse(computeTaskChecksum(tempSnapshotDir));
    const { fileCount: snapshotFileCount, totalBytes: snapshotBytes } = snapshotFileBytes(tempSnapshotDir);
    const storeRoot = join(resolve(dirname(opts.ndjsonPath)), "snapshots");
    const persistentDir = join(storeRoot, snapshotId);
    if (!existsSync(persistentDir)) {
      mkdirSync(persistentDir, { recursive: true });
      cpSync(tempSnapshotDir, persistentDir, { recursive: true });
    }
    makeReadOnlyRecursive(persistentDir);
    if (computeTaskChecksum(persistentDir) !== snapshotId) {
      failResult("Snapshot integrity violated: sealed evidence-store hash differs from initial snapshot hash.", "Ensure snapshots are content-addressed and immutable.");
    }
    const snapshotRef: SealedSnapshotRef = {
      snapshotId,
      storePath: persistentDir,
      fileCount: snapshotFileCount,
      totalBytes: snapshotBytes,
      sealedAt: new Date().toISOString(),
    };
    push("snapshot_sealed", snapshotRef.sealedAt);
    assertMonotonic([...log]);

    // Gate transcript (observed, never re-evaluated: single evaluation).
    let gateResult: GateEvaluationResult | undefined;
    let gateTriggered: string | null = null;
    let gateVerdict: CompletionClaimVerdict = "NOT_EVALUATED";
    let failureReasons: readonly string[] | undefined = undefined;
    if (native.gateRequested) {
      if (opts.arm === "A0_baseline") {
        failResult(`Trial "${native.harborTrialName}" requested a gate verdict on arm A0_baseline (no treatment allowed).`, "The bridge must skip the handshake on A0.");
      }
      if (native.gateVerdictObserved === null) {
        failResult(`Trial "${native.harborTrialName}" requested a gate verdict but none was delivered.`, "Gate requests must be answered exactly once during the session.");
      }
      if (native.gateEvaluatedAt === null) {
        failResult(`Trial "${native.harborTrialName}" requested a gate verdict without its persisted evaluation timestamp.`, "Gate verdicts must preserve the original evaluation timestamp.");
      }
      if (native.gateSnapshotHash !== null && native.gateSnapshotHash !== snapshotId) {
        failResult(
          `Gate/seal snapshot divergence for trial "${native.harborTrialName}": gate evaluated "${native.gateSnapshotHash}" but sealed "${snapshotId}".`,
          "The snapshot must not change between gate evaluation and sealing (TOCTOU guard).",
        );
      }
      gateTriggered = native.gateId;
      gateVerdict = native.gateVerdictObserved;
      gateResult = {
        gateId: native.gateId ?? "unknown",
        verdict: native.gateVerdictObserved === "PASS" ? "PASS" : "FAIL",
        evaluatedAt: native.gateEvaluatedAt,
        checks: native.gateChecks.map((check) => ({
          id: check.id,
          verdict: check.verdict,
          evidence: [...check.evidence],
          message: check.message,
        })),
      };
      if (native.gateFailureReasons.length > 0) {
        failureReasons = [...native.gateFailureReasons];
      }
      // R8 item 4: gate_evaluated is logged only when a gate was actually
      // requested and observed. A0 records no gate event at all.
      push("gate_evaluated", new Date().toISOString());
      assertMonotonic([...log]);
    } else {
      assertMonotonic([...log]);
    }

    if (claimed && stopReason !== "agent_declared_done") {
      failResult("Internal error: claimed trial without declared-done stop.", "Bridge protocol breach.");
    }
    const finalClaim: CompletionClaim = claimed
      ? {
          claimIndex: 0,
          timestamp: claimTimestamp,
          workspaceHash: snapshotId,
          claimSnapshotId: snapshotId,
          gateTriggered,
          gateVerdict,
          ...(failureReasons ? { failureReasons } : {}),
          recoveryTriggered: native.recoveryAttempts > 0,
          promptTokensAtClaim: native.promptTokensAtClaim,
          snapshotVerification: { status: null, reward: null, verifierOutputHash: null },
        }
      : {
          // Placeholder: unclaimed trials persist claims: [] below; this
          // object only satisfies construction flow and is never stored.
          claimIndex: 0,
          timestamp: claimTimestamp,
          workspaceHash: snapshotId,
          claimSnapshotId: snapshotId,
          gateTriggered,
          gateVerdict,
          recoveryTriggered: native.recoveryAttempts > 0,
          promptTokensAtClaim: null,
          snapshotVerification: { status: null, reward: null, verifierOutputHash: null },
        };

    const recordTrialId = totalTrials === 1 ? opts.trialId : `${opts.trialId}__${native.harborTrialName}`;
    const durationMs = Date.now() - sliceStart;
    const provenance = {
      prompt: {
        kind: "prompt-bytes" as const,
        originPath: pr.promptOrigin,
        byteLength: pr.promptBytes.length,
        sha256: pr.promptHash,
      },
      container: {
        kind: "container-manifest" as const,
        originPath: resolve(opts.harborRequest.jobConfigPath),
        byteLength: man.manifestBytes.length,
        sha256: pr.manifestHash,
      },
      workspaceSnapshot: {
        kind: "workspace-snapshot" as const,
        originPath: `container-export:${native.harborTrialName}`,
        byteLength: snapshotBytes,
        sha256: snapshotId,
      },
    };
    const harborCorrelation = {
      jobId: job.sessionRunId,
      trialId: native.harborTrialId,
      trialName: native.harborTrialName,
      resultPath: native.trialResultPath,
      resultHash: native.trialResultHash,
      containerId: native.containerId,
      containerDigest: native.containerDigestEffective,
    };
    const baseExecution = {
      runtimeId: opts.runtimeId,
      runtimeVersion: opts.runtimeVersion,
      model: opts.agent.modelName,
      modelTemperature: opts.modelTemperature ?? null,
      runtimeRunId: native.harborTrialId,
      workspaceId: native.harborTrialName,
    };
    const baseTask = {
      id: opts.task.taskId,
      benchmark: "terminal-bench" as const,
      benchmarkVersion: opts.task.benchmarkVersion,
      taskHash: opts.task.taskChecksum,
    };
    const baseRepro = {
      configHash: cfgHash,
      promptHash: pr.promptHash,
      containerDigest: native.containerDigestEffective,
    };
    const baseUsageTokens = {
      inputTokens: native.inputTokens,
      outputTokens: native.outputTokens,
      costUsd: native.costUsd,
    };

    // A2 BLOCK: verifier must be ABSENT with a GateBlocked exception (the
    // prevention proof). Present verifier + BLOCK verdict = bridge lied.
    const blocked = (opts.arm === "A2_blocking" || opts.arm === "A3_recovering") && gateVerdict === "BLOCK";
    if (blocked) {
      if (native.verifierPresent) {
        failResult(
          `Trial "${native.harborTrialName}" was BLOCKED yet carries verifier evidence: the bridge claims prevention while the verifier ran.`,
          "A2+BLOCK is licit only when the bridge genuinely prevented verifier start (verifier TimingInfo null).",
        );
      }
      if (!native.gateBlocked) {
        failResult(
          `Trial "${native.harborTrialName}" was BLOCKED without a ShokuninGateBlocked exception in the native result.`,
          "Prevention must be proven by the bridge exception, not inferred.",
        );
      }
      const trial: BenchmarkTrial = {
        experimentId: opts.experimentId,
        hypothesisId: opts.hypothesisId,
        trialId: recordTrialId,
        campaignId: opts.campaignId,
        arm: opts.arm,
        repetitionIndex: opts.repetitionIndex,
        task: baseTask,
        reproducibility: baseRepro,
        provenance,
        harbor: harborCorrelation,
        distribution: job.distribution.identity,
        execution: { ...baseExecution, claims: [finalClaim], finalStopReason: "gate_blocked_exhausted", totalRecoveryCount: native.recoveryAttempts },
        verifier: null,
        failureClassification: "GOVERNANCE_FAILURE",
        metrics: { falseCompletionInitial: null, falseCompletionTerminal: null, falseCompletionIntercepted: null, recoverySuccessful: native.recoverySuccessful },
        usage: { ...baseUsageTokens, durationMs },
      };
      push("trial_blocked", new Date().toISOString());
      assertMonotonic([...log]);
      assertTerminalEvent([...log], "trial_blocked");
      return { trial: benchmarkTrialSchema.parse(trial) as BenchmarkTrial, eventLog: [...log], snapshotRef, gateResult, blocked: true };
    }

    // Non-blocked trials without verifier evidence need an explanation.
    if (!native.verifierPresent) {
      if (stopReason === "timeout") {
        // Harbor runs the verifier even after agent timeouts; absent verifier
        // here means the verifier itself failed — quarantine with timeout stop.
        const trial: BenchmarkTrial = {
          experimentId: opts.experimentId,
          hypothesisId: opts.hypothesisId,
          trialId: recordTrialId,
          campaignId: opts.campaignId,
          arm: opts.arm,
          repetitionIndex: opts.repetitionIndex,
          task: baseTask,
          reproducibility: baseRepro,
          provenance,
          harbor: harborCorrelation,
          distribution: job.distribution.identity,
          execution: { ...baseExecution, claims: [], finalStopReason: "timeout", totalRecoveryCount: 0 },
          verifier: null,
          failureClassification: "AGENT_RUNTIME_FAILURE",
          metrics: { falseCompletionInitial: null, falseCompletionTerminal: null, falseCompletionIntercepted: null, recoverySuccessful: null },
          usage: { ...baseUsageTokens, inputTokens: null, outputTokens: null, costUsd: null, durationMs },
        };
        push("verifier_skipped", new Date().toISOString());
        assertMonotonic([...log]);
        assertTerminalEvent([...log], "verifier_skipped");
        return { trial: benchmarkTrialSchema.parse(trial) as BenchmarkTrial, eventLog: [...log], snapshotRef, gateResult, blocked: false };
      }
      failResult(
        `Trial "${native.harborTrialName}" has no verifier evidence and no blocking/timeout explanation.`,
        "Unexplained verifier absence is quarantined, never normalized.",
      );
    }

    // Completed path (verifier evidence kept — R6 item 6 — including A1
    // observed-BLOCK and timeout trials whose verifier ran).
    const verifier: BenchmarkTrialVerifier = {
      authority: "harbor-task-verifier",
      passed: native.passed,
      reward: native.reward,
      durationMs: native.verifierDurationMs,
      verifierOutputHash: native.verifierOutputHash,
    };
    const finalStop: BenchmarkTrialStopReason =
      stopReason === "timeout" ? "timeout" : stopReason === "error" ? "error" : "agent_declared_done";
    const record: BenchmarkTrial = {
      experimentId: opts.experimentId,
      hypothesisId: opts.hypothesisId,
      trialId: recordTrialId,
      campaignId: opts.campaignId,
      arm: opts.arm,
      repetitionIndex: opts.repetitionIndex,
      task: baseTask,
      reproducibility: baseRepro,
      provenance,
      harbor: harborCorrelation,
      distribution: job.distribution.identity,
      execution: {
        ...baseExecution,
        claims: claimed ? [finalClaim] : [],
        finalStopReason: finalStop,
        totalRecoveryCount: native.recoveryAttempts,
      },
      verifier,
      failureClassification: null,
      metrics: {
        falseCompletionInitial: null,
        falseCompletionTerminal: claimed ? !native.passed : null,
        falseCompletionIntercepted: null,
        recoverySuccessful: native.recoverySuccessful,
      },
      usage: { ...baseUsageTokens, durationMs },
    };
    push("verifier_finished", new Date().toISOString());
    assertMonotonic([...log]);
    assertTerminalEvent([...log], "verifier_finished");
    return { trial: benchmarkTrialSchema.parse(record) as BenchmarkTrial, eventLog: [...log], snapshotRef, gateResult, blocked: false };
  }

  function digestMatchesPin(native: HarborSessionTrialNative, pin: string): boolean {
    if (native.containerDigestEffective.toLowerCase() === pin.toLowerCase()) return true;
    return native.containerRepoDigests.some((d) => d.toLowerCase() === pin.toLowerCase());
  }

  function buildJobFailureRecord(
    opts: VerticalSliceOptions,
    man: ManifestBinding,
    pr: PromptEvidence,
    cfgHash: string,
    job: HarborSessionJob | null,
    sliceStart: number,
    err: unknown,
    forceClassification?: TrialFailureClassification | undefined,
  ): BenchmarkTrial {
    const code = err instanceof ActionableBenchmarkError ? err.code : "UNKNOWN";
    const message = err instanceof Error ? err.message : String(err);
    const classification: TrialFailureClassification = forceClassification ?? (
      code === "TRIAL_TIMEOUT" || code === "HARNESS_UNAVAILABLE" || code === "INFRASTRUCTURE_FAILURE"
        ? "EXOGENOUS_INFRASTRUCTURE_FAILURE"
        : "VERIFIER_FAILURE"
    );
    const stopReason: BenchmarkTrialStopReason = code === "TRIAL_TIMEOUT" ? "timeout" : "error";
    const failureDir = mkdtempSync(join(tmpdir(), `harbor-failure-${opts.trialId}-`));
    tempDirs.push(failureDir);
    return sealFailureRecord(opts, man, pr, cfgHash, job, sliceStart, failureDir, classification, stopReason, code, message);
  }

  function buildCorruptTrialRecord(
    opts: VerticalSliceOptions,
    man: ManifestBinding,
    pr: PromptEvidence,
    cfgHash: string,
    job: HarborSessionJob,
    native: HarborSessionTrialNative,
    totalTrials: number,
    sliceStart: number,
    err: ActionableBenchmarkError,
  ): { trial: BenchmarkTrial; eventLog: RuntimeEventLog; snapshotRef: SealedSnapshotRef } {
    const failureDir = mkdtempSync(join(tmpdir(), `harbor-failure-${opts.trialId}-`));
    tempDirs.push(failureDir);
    const recordTrialId = totalTrials === 1 ? opts.trialId : `${opts.trialId}__${native.harborTrialName}`;
    const trial = sealFailureRecord(
      opts, man, pr, cfgHash, job, sliceStart, failureDir,
      "VERIFIER_FAILURE", "error", err.code, err.message, recordTrialId,
      { jobId: job.sessionRunId, trialId: native.harborTrialId, trialName: native.harborTrialName, resultPath: native.trialResultPath, resultHash: native.trialResultHash, containerId: native.containerId || "unknown", containerDigest: native.containerDigestEffective || opts.expectedContainerDigest },
    );
    const eventLog: RuntimeEventLog = [
      { event: "agent_started", timestamp: native.agentStartedAt },
      // R7 item 7: no native_completion_claim is synthesized when the claim
      // sidecar is absent — not even in quarantine records.
      ...(native.claimPresent && native.claimTimestamp !== null
        ? [{ event: "native_completion_claim", timestamp: native.claimTimestamp } as const]
        : []),
      { event: "verifier_skipped", timestamp: new Date().toISOString() },
    ];
    assertMonotonic([...eventLog]);
    assertTerminalEvent([...eventLog], "verifier_skipped");
    return { trial, eventLog, snapshotRef: readFailureSnapshot() };
  }

  function sealFailureRecord(
    opts: VerticalSliceOptions,
    man: ManifestBinding,
    pr: PromptEvidence,
    cfgHash: string,
    job: HarborSessionJob | null,
    sliceStart: number,
    failureDir: string,
    classification: TrialFailureClassification,
    stopReason: BenchmarkTrialStopReason,
    code: string,
    message: string,
    recordTrialId?: string,
    harbor?: BenchmarkTrial["harbor"],
  ): BenchmarkTrial {
    const finalTrialId = recordTrialId ?? opts.trialId;
    const sealedAt = new Date().toISOString();
    writeFileSync(
      join(failureDir, "failure.json"),
      JSON.stringify({ trialId: finalTrialId, arm: opts.arm, code, message, timestamp: sealedAt }),
    );
    assertNoSpecialFiles(failureDir);
    const snapshotId = sha256HexSchema.parse(computeTaskChecksum(failureDir));
    const { fileCount: failureFileCount, totalBytes: failureBytes } = snapshotFileBytes(failureDir);
    const storeRoot = join(resolve(dirname(opts.ndjsonPath)), "snapshots");
    const persistentDir = join(storeRoot, snapshotId);
    if (!existsSync(persistentDir)) {
      mkdirSync(persistentDir, { recursive: true });
      cpSync(failureDir, persistentDir, { recursive: true });
    }
    makeReadOnlyRecursive(persistentDir);
    if (computeTaskChecksum(persistentDir) !== snapshotId) {
      failResult("Failure snapshot integrity violated after sealing.", "Ensure failure evidence is immutable.");
    }
    const snapshotRef: SealedSnapshotRef = {
      snapshotId,
      storePath: persistentDir,
      fileCount: failureFileCount,
      totalBytes: failureBytes,
      sealedAt,
    };
    lastFailureSnapshot = snapshotRef;
    const durationMs = Date.now() - sliceStart;
    return benchmarkTrialSchema.parse({
      experimentId: opts.experimentId,
      hypothesisId: opts.hypothesisId,
      trialId: finalTrialId,
      campaignId: opts.campaignId,
      arm: opts.arm,
      repetitionIndex: opts.repetitionIndex,
      task: {
        id: opts.task.taskId,
        benchmark: "terminal-bench",
        benchmarkVersion: opts.task.benchmarkVersion,
        taskHash: opts.task.taskChecksum,
      },
      reproducibility: { configHash: cfgHash, promptHash: pr.promptHash, containerDigest: opts.expectedContainerDigest },
      provenance: {
        prompt: { kind: "prompt-bytes", originPath: pr.promptOrigin, byteLength: pr.promptBytes.length, sha256: pr.promptHash },
        container: { kind: "container-manifest", originPath: resolve(opts.harborRequest.jobConfigPath), byteLength: man.manifestBytes.length, sha256: pr.manifestHash },
        workspaceSnapshot: { kind: "workspace-snapshot", originPath: `failure-context:${finalTrialId}`, byteLength: failureBytes, sha256: snapshotId },
      },
      harbor: harbor ?? null,
      distribution: job ? job.distribution.identity : "cli-shape-only",
      execution: {
        runtimeId: opts.runtimeId,
        runtimeVersion: opts.runtimeVersion,
        model: opts.agent.modelName,
        modelTemperature: opts.modelTemperature ?? null,
        runtimeRunId: job ? job.sessionRunId : finalTrialId,
        workspaceId: "none",
        claims: [],
        finalStopReason: stopReason,
        totalRecoveryCount: 0,
      },
      verifier: null,
      failureClassification: classification,
      metrics: {
        falseCompletionInitial: null,
        falseCompletionTerminal: null,
        falseCompletionIntercepted: null,
        recoverySuccessful: null,
      },
      usage: { inputTokens: null, outputTokens: null, costUsd: null, durationMs },
    }) as BenchmarkTrial;
  }
}

function readManifestBinding(manifestBytes: Buffer): ManifestBinding {
  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    failConfig("Job manifest is not valid YAML.", "Provide a valid Harbor job-config.yaml.");
  }
  const agents = (parsed! as Record<string, unknown>)["agents"];
  const agentObj = (Array.isArray(agents) ? agents[0] : undefined) as Record<string, unknown> | undefined;
  if (!agentObj || typeof agentObj["name"] !== "string" || (agentObj["name"] as string).length === 0) {
    failConfig("Manifest declares no agent name.", "Author experiment manifests with the lab-owned bridge agent.");
  }
  if (typeof agentObj["import_path"] !== "string" || (agentObj["import_path"] as string).length === 0) {
    failConfig("Manifest agent declares no import_path.", "The bridge agent must be loaded via import_path (auditable).");
  }
  if (typeof agentObj["model_name"] !== "string" || (agentObj["model_name"] as string).length === 0) {
    failConfig("Manifest declares no agent model_name. Options→manifest model binding requires it.", "Declare agents[0].model_name in job-config.yaml matching the experiment model.");
  }
  const kwargs = agentObj["kwargs"] as Record<string, unknown> | undefined;
  if (!kwargs || typeof kwargs["shokunin_inner_agent"] !== "string" || (kwargs["shokunin_inner_agent"] as string).length === 0) {
    failConfig("Manifest agent kwargs declare no shokunin_inner_agent.", "Declare the wrapped experiment agent in kwargs.");
  }
  if (typeof kwargs["shokunin_arm"] !== "string" || (kwargs["shokunin_arm"] as string).length === 0) {
    failConfig("Manifest agent kwargs declare no shokunin_arm.", "Declare the experiment arm in kwargs.");
  }
  const digest = kwargs["shokunin_expected_digest"];
  return {
    manifestBytes,
    bridgeAgentName: agentObj["name"] as string,
    bridgeImportPath: agentObj["import_path"] as string,
    bridgeModelName: agentObj["model_name"] as string,
    bridgeInnerAgent: kwargs["shokunin_inner_agent"] as string,
    bridgeArm: kwargs["shokunin_arm"] as string,
    bridgeExpectedDigest: typeof digest === "string" && digest.length > 0 ? digest : null,
  };
}

function readPromptEvidence(options: VerticalSliceOptions): Omit<PromptEvidence, "manifestHash"> {
  if (options.agent.promptPath && existsSync(options.agent.promptPath)) {
    const promptBytes = readFileSync(options.agent.promptPath);
    return {
      promptBytes,
      promptOrigin: resolve(options.agent.promptPath),
      promptHash: sha256HexSchema.parse(createHash("sha256").update(promptBytes).digest("hex")),
    };
  }
  if (typeof options.agent.promptContent === "string" && options.agent.promptContent.length > 0) {
    const promptBytes = Buffer.from(options.agent.promptContent, "utf8");
    return {
      promptBytes,
      promptOrigin: "<inline-prompt>",
      promptHash: sha256HexSchema.parse(createHash("sha256").update(promptBytes).digest("hex")),
    };
  }
  failConfig(
    "Missing prompt evidence: promptPath (existing file) or non-empty promptContent is required. Bare hashes without bytes are rejected.",
    "Provide agent.promptPath or agent.promptContent; the hash is derived mechanically from bytes.",
  );
}
