export type TrialArm = "baseline" | "treatment";
export type TrialStatus = "completed" | "infrastructure_failure" | "invalid";
export type MetricValue = number | null;

export type Sha256Hex = string & { readonly __brand: "Sha256Hex" };

// Canonical Snapshot Verification Model (Section 5.1 of Master Plan)
export type SnapshotVerificationStatus = "PASS" | "FAIL" | "ERROR" | null;

export interface SnapshotVerification {
  readonly status: SnapshotVerificationStatus;
  readonly reward: number | null;
  readonly verifierOutputHash: string | null;
}

// Runtime Qualification Matrix (Section 4.1 of Master Plan)
export interface RuntimeCapabilityMatrix {
  readonly runtimeId: string;
  readonly nativeStopSignal: string;
  readonly claimExtractionMethod: string;
  readonly sessionResumeSupported: boolean;
  readonly structuredFeedbackSupported: boolean;
  readonly usageTelemetrySupported: boolean;
  readonly trajectoryFormat: string;
  readonly adapterVersion: string;
}

// Canonical Failure Taxonomy (Section 4.4 of Master Plan)
export type TrialFailureClassification =
  | "EXOGENOUS_INFRASTRUCTURE_FAILURE"
  | "AGENT_RUNTIME_FAILURE"
  | "GOVERNANCE_FAILURE"
  | "VERIFIER_FAILURE";

// Backwards-compatible G0 Trial Record contracts
export type VerificationStatus = "verified" | "unverified" | "not_applicable";

export type RuntimeCapabilityType =
  | "stop_signal"
  | "claim_extraction"
  | "session_resume"
  | "feedback_injection"
  | "usage_telemetry"
  | "trajectory_recording";

export interface RuntimeCapability {
  readonly capability: RuntimeCapabilityType;
  readonly status: VerificationStatus;
  readonly evidence: string | null;
}

export interface ClaimMetrics {
  readonly taskSuccess: MetricValue;
  readonly wallClockSeconds: MetricValue;
  readonly inputTokens: MetricValue;
  readonly outputTokens: MetricValue;
  readonly estimatedCostUsd: MetricValue;
}

export type InfrastructureFailureCategory =
  | "CONTAINER_CRASH"
  | "HARNESS_CRASH"
  | "NETWORK_TIMEOUT"
  | "OUT_OF_MEMORY"
  | "DISK_EXHAUSTION"
  | "ORACLE_TIMEOUT"
  | "UNKNOWN";

export interface InfrastructureFailure {
  readonly category: InfrastructureFailureCategory;
  readonly message: string;
  readonly retryable: boolean;
}

export interface TrialRecord {
  readonly schemaVersion: "1.0.0";
  readonly trialId: string;
  readonly taskClusterId: string;
  readonly taskId: string;
  readonly arm: TrialArm;
  readonly repetition: number;
  readonly seed: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: TrialStatus;
  readonly harnessVersion: string;
  readonly benchmarkCommit: string;
  readonly subjectSnapshot: {
    readonly status: VerificationStatus;
    readonly requestedRef: string | null;
    readonly resolvedCommit: string | null;
    readonly reason: string | null;
  };
  readonly runtimeCapabilities: readonly RuntimeCapability[];
  readonly metrics: ClaimMetrics;
  readonly infrastructureFailure: InfrastructureFailure | null;
  readonly failureClassification?: TrialFailureClassification | null;
  readonly evidencePaths: readonly string[];
}

// Canonical Experimental Model (H1 Apparatus)
export type CompletionClaimVerdict = "PASS" | "BLOCK" | "NOT_EVALUATED";
export interface CompletionClaim {
  readonly claimIndex: number;
  readonly timestamp: string;
  readonly workspaceHash: string;
  readonly claimSnapshotId: string;
  readonly gateTriggered: string | null;
  readonly gateVerdict: CompletionClaimVerdict;
  readonly failureReasons?: readonly string[] | undefined;
  readonly recoveryTriggered: boolean;
  readonly promptTokensAtClaim: number | null;
  readonly snapshotVerification: SnapshotVerification;
}

export type BenchmarkTrialArm =
  | "A0_baseline"
  | "A1_observing"
  | "A2_blocking"
  | "A3_recovering";

export type BenchmarkTrialStopReason =
  | "agent_declared_done"
  | "gate_blocked_exhausted"
  | "timeout"
  | "error"
  | "unclaimed_failure";

export interface BenchmarkTrialTask {
  readonly id: string;
  readonly benchmark: "terminal-bench";
  readonly benchmarkVersion: string;
  readonly taskHash: string;
}

export interface BenchmarkTrialReproducibility {
  readonly configHash: string;
  readonly promptHash: string;
  readonly containerDigest: string;
}

// Artifact-bound provenance (R5): every hash persisted alongside a verifiable
// artefact reference (origin path, byte length). Bare hashes are rejected.
export type ArtifactProvenanceKind =
  | "prompt-bytes"
  | "container-manifest"
  | "workspace-snapshot";

export interface ArtifactProvenanceRef {
  readonly kind: ArtifactProvenanceKind;
  readonly originPath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface BenchmarkTrialProvenance {
  readonly prompt: ArtifactProvenanceRef;
  readonly container: ArtifactProvenanceRef;
  readonly workspaceSnapshot: ArtifactProvenanceRef;
}

// Native Harbor correlation (R5 single-run session, R6 live container facts):
// links the canonical record to the exact Harbor job/trial/container that
// produced it. Null only for infrastructure-failure records without trials.
export interface BenchmarkTrialHarborCorrelation {
  readonly jobId: string;
  readonly trialId: string;
  readonly trialName: string;
  readonly resultPath: string;
  readonly resultHash: string;
  /** Live container ID inspected by the bridge pre-verifier. */
  readonly containerId: string;
  /** Effective image digest of the LIVE container (image ID or RepoDigest). */
  readonly containerDigest: string;
}

export interface BenchmarkTrialExecution {
  readonly runtimeId: string;
  readonly runtimeVersion: string;
  readonly model: string;
  readonly modelTemperature: number | null;
  /** Native Harbor trial UUID this execution derives from (single-run session). */
  readonly runtimeRunId: string;
  /** Native Harbor trial name this execution derives from. */
  readonly workspaceId: string;
  readonly claims: readonly CompletionClaim[];
  readonly finalStopReason: BenchmarkTrialStopReason;
  readonly totalRecoveryCount: number;
}

export interface BenchmarkTrialVerifier {
  readonly authority: "harbor-task-verifier";
  readonly passed: boolean;
  readonly reward: number;
  readonly durationMs: number;
  readonly verifierOutputHash: string;
}

export interface BenchmarkTrialMetrics {
  readonly falseCompletionInitial: boolean | null;
  readonly falseCompletionTerminal: boolean | null; // Null when verifier is null (e.g. A2 blocked), boolean when evaluated by Harbor verifier
  readonly falseCompletionIntercepted: boolean | null;
  readonly recoverySuccessful: boolean | null;
}

export interface BenchmarkTrialUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly durationMs: number;
}

export interface BenchmarkTrial {
  readonly experimentId: string;
  readonly hypothesisId: string;
  readonly trialId: string;
  readonly campaignId: string;
  readonly arm: BenchmarkTrialArm;
  readonly repetitionIndex: number;
  readonly task: BenchmarkTrialTask;
  readonly reproducibility: BenchmarkTrialReproducibility;
  readonly provenance: BenchmarkTrialProvenance;
  readonly harbor: BenchmarkTrialHarborCorrelation | null;
  /**
   * Distribution authentication level of the Harbor session that produced
   * this record. `wheel-verified` means the executed Harbor bytes came from
   * the lab-pinned official wheel (hash compared to the immutable laboratory
   * allowlist — no caller-supplied hash can validate). `cli-shape-only`
   * records (unverifiable launchers) can never support a G2 sealing claim.
   */
  readonly distribution: "wheel-verified" | "cli-shape-only";
  readonly execution: BenchmarkTrialExecution;
  readonly verifier: BenchmarkTrialVerifier | null;
  readonly failureClassification: TrialFailureClassification | null;
  readonly metrics: BenchmarkTrialMetrics;
  readonly usage: BenchmarkTrialUsage;
}

export type CompletedBenchmarkTrial = BenchmarkTrial & {
  readonly verifier: BenchmarkTrialVerifier;
  readonly failureClassification: null;
};

export type FailedBenchmarkTrial = BenchmarkTrial & {
  readonly verifier: null;
  readonly failureClassification: TrialFailureClassification;
};
