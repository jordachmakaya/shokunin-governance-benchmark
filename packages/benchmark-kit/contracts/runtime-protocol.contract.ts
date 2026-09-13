/**
 * @fileoverview In-runtime pre-verifier interception protocol (ZB2.2-R6).
 *
 * R5 ran a single `harbor run` but reconstructed the causal cycle post-hoc:
 * agent → verifier → session return → snapshot → gate. R6 moves interception
 * INSIDE the trial: the lab-owned bridge agent
 * (bridge/shokunin_intercept_agent.py, loaded by Harbor via the manifest
 * agent `import_path`) observes the native agent outcome, exports the LIVE
 * container workspace, resolves the LIVE container identity, and handshakes
 * the gate BEFORE Harbor starts the verifier. On A2+BLOCK the bridge raises
 * inside the agent phase, so `TrialResult.verifier` stays `None` — the
 * prevention proof. The TypeScript session spawns the run and answers gate
 * requests concurrently; mocks simulate bridge sidecar bytes on the same
 * protocol, never production helpers.
 */

export interface RuntimeClaimEvent {
  /** Always literally true: present only for natively completed agent phases. */
  readonly declaredDone: true;
  /**
   * ISO datetime the bridge observed the clean agent return. Timeouts and
   * errors never produce a claim (runs without claim are unclaimed/timeout/
   * error); `agent_execution.finished_at` is a timing and is never coerced.
   */
  readonly timestamp: string;
  /** Native Harbor trial UUID this claim derives from. */
  readonly runtimeRunId: string;
  /** Native Harbor trial name this claim derives from. */
  readonly workspaceId: string;
  readonly promptTokensAtClaim?: number | null | undefined;
}

/** Native agent outcome without claim (timeout/error paths). */
export interface NativeAgentOutcome {
  readonly declaredDone: false;
  readonly reason: "agent_timeout" | "agent_error";
  readonly message?: string | undefined;
  readonly observedAt: string;
}

export type RuntimePhaseEvent =
  | "agent_started"
  | "native_completion_claim"
  | "snapshot_sealed"
  | "gate_evaluated"
  | "verifier_finished"
  | "verifier_skipped"
  | "trial_blocked";

export interface RuntimeEventRecord {
  readonly event: RuntimePhaseEvent;
  readonly timestamp: string;
}

export type RuntimeEventLog = readonly RuntimeEventRecord[];

/**
 * Immutable, content-addressed snapshot reference.
 * `snapshotId` is the SHA-256 of the sealed snapshot bytes (dirhash).
 * `storePath` is the persistent evidence-store directory, read-only.
 */
export interface SealedSnapshotRef {
  readonly snapshotId: string;
  readonly storePath: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly sealedAt: string;
}

/**
 * Artifact-bound provenance reference. Bare hashes without an associated
 * verifiable artefact are rejected. R5 persists these inside every
 * BenchmarkTrial (`provenance` field); the contract is not decorative.
 * Canonical definition lives in trial.contract.ts.
 */
export type { ArtifactProvenanceRef } from "./trial.contract.js";

export interface GateCheckTranscript {
  readonly id: string;
  readonly verdict: "PASS" | "FAIL";
  readonly evidence: readonly string[];
  readonly message: string;
}

/**
 * Gate decision callback invoked by the session when a trial's
 * gate-request.json appears. Implemented by the slice with the experiment
 * CompletionGate; the session only transports the verdict.
 */
export type GateDecider = (snapshotDir: string) => Promise<{
  readonly verdict: "PASS" | "BLOCK";
  readonly failureReasons?: readonly string[] | undefined;
  readonly checks: readonly GateCheckTranscript[];
  readonly gateId: string;
}>;

export interface HarborSessionRequest {
  readonly jobConfigPath: string;
  readonly jobsRoot: string;
  readonly expectedJobName: string;
  readonly timeoutMs: number;
  readonly successCriterion: string;
  readonly expectedTaskChecksum: string;
  readonly taskDirectory?: string | undefined;
  /** Experiment arm driving the bridge handshake (A0 skips, A1 observes, A2 blocks). */
  readonly arm: "A0_baseline" | "A1_observing" | "A2_blocking" | "A3_recovering";
  /** REQUIRED for A1/A2: answers live gate requests during the session. */
  readonly gateDecider?: GateDecider | undefined;
  /** Durable session ledger path (job STARTED written pre-spawn). */
  readonly ledgerPath: string;
  /**
   * Lab-pinned expected container digest (image ID or RepoDigest). The bridge
   * compares it against the LIVE inspected container; mismatch fails closed.
   * REQUIRED: unpinned container runs are not evidence-grade.
   */
  readonly expectedContainerDigest: string;
}

/**
 * One native Harbor trial of a single bridge session. Claim/outcome,
 * container identity, workspace export and gate transcript are bridge sidecar
 * files observed in the trial directory — never reconstructed post-hoc.
 */
export interface HarborSessionTrialNative {
  readonly harborJobId: string;
  readonly harborTrialId: string;
  readonly harborTrialName: string;
  readonly trialDirectory: string;
  readonly trialResultPath: string;
  readonly trialResultHash: string;
  /** True iff the bridge wrote claim.json (clean native agent return). */
  readonly claimPresent: boolean;
  readonly claimTimestamp: string | null;
  readonly agentOutcome: NativeAgentOutcome | null;
  readonly agentStartedAt: string;
  readonly agentName: string;
  readonly modelName: string | null;
  readonly taskName: string;
  readonly taskPath: string;
  readonly taskChecksum: string;
  readonly trialUri: string;
  readonly reward: number;
  readonly passed: boolean;
  /** True iff the native result carries verifier timing (verifier STARTED). */
  readonly verifierPresent: boolean;
  /** True iff the native result carries a ShokuninGateBlocked exception. */
  readonly gateBlocked: boolean;
  readonly verifierDurationMs: number;
  readonly verifierOutputHash: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly promptTokensAtClaim: number | null;
  /** Bridge-exported pre-verifier workspace directory (live container). */
  readonly snapshotDir: string;
  readonly exportedPaths: readonly string[];
  /** True iff a gate handshake was requested for this trial. */
  readonly gateRequested: boolean;
  readonly gateVerdictObserved: "PASS" | "BLOCK" | null;
  readonly gateEvaluatedAt: string | null;
  readonly gateSnapshotHash: string | null;
  readonly gateId: string | null;
  readonly gateFailureReasons: readonly string[];
  readonly gateChecks: readonly GateCheckTranscript[];
  readonly containerId: string;
  readonly containerDigestEffective: string;
  readonly containerImageRef: string | null;
  readonly containerRepoDigests: readonly string[];
  readonly recoveryAttempts: number;
  readonly recoverySuccessful: boolean | null;
}

export interface HarborSessionJob {
  /** Native Harbor job UUID — the single session run ID. */
  readonly sessionRunId: string;
  readonly jobDirectory: string;
  readonly jobResultHash: string;
  /** Effective OCI digest of the LIVE container (bridge-inspected). */
  readonly effectiveContainerDigest: string;
  /** SHA-256 of the bridge module file actually placed on PYTHONPATH. */
  readonly bridgeSha256: string;
  /** Distribution attestation: wheel hash vs laboratory allowlist. */
  readonly distribution: HarborDistributionAttestation;
  readonly trials: readonly HarborSessionTrialNative[];
}

/** Distribution attestation attached to a session (lab authority, R6). */
export interface HarborDistributionAttestation {
  readonly identity: HarborDistributionIdentity;
  readonly harborVersion: string | null;
  readonly versionSource: "importlib" | "help-text" | "unresolved";
  readonly wheelSha256: string;
  /** SHA-256 of the bridge module file placed on PYTHONPATH (R7 item 5). */
  readonly bridgeSha256: string;
  /** Allowlisted bridge version for those bytes, null when unverified. */
  readonly bridgeVersion: string | null;
}

export type HarborDistributionIdentity =
  | "wheel-verified"
  | "cli-shape-only";

/**
 * Single in-runtime interception session. Implementations spawn exactly one
 * Harbor run whose trials carry the bridge agent; per-trial natives derive
 * from that run's artefacts plus bridge sidecars. No second execution exists.
 */
export interface IPhasedHarborSession {
  executeSession(request: HarborSessionRequest): Promise<HarborSessionJob>;
}

/**
 * Closed launcher specification (R7 item 5). Only these two shapes exist:
 * a uv+wheel launch built entirely by the session, or a plain executable
 * that can never inherit wheel trust.
 */
export type HarborLaunchSpec =
  | {
      readonly kind: "uv-wheel";
      readonly uvPath?: string | undefined;
      readonly pythonVersion?: string | undefined;
      readonly requirementsLockPath?: string | undefined;
    }
  | { readonly kind: "plain"; readonly executable: string };

/** Construction options for the production bridge session. */
export interface HarborBridgeSessionOptions {
  readonly executor?: unknown;
  /**
   * Closed launch specification (R7 item 5): the session BUILDS the launch
   * command from these verified inputs. There is no free-form command field,
   * so a counterfeit launcher cannot smuggle the real wheel path into
   * unrelated arguments and inherit trust.
   */
  readonly launch: HarborLaunchSpec;
  /** Absolute path to bridge/shokunin_intercept_agent.py (PYTHONPATH root is its dirname). */
  readonly bridgeScriptPath: string;
  /** Absolute path to the official Harbor wheel (hash-checked vs allowlist). */
  readonly wheelPath: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
}
