import { z } from "zod";

const nullableMetricSchema = z.number().finite().nonnegative().nullable();

export const sha256HexPattern = /^(?:sha256:)?[0-9a-f]{64}$/i;
export const sha256HexSchema = z
  .string()
  .regex(sha256HexPattern, "Must be a valid 64-character hexadecimal SHA-256 hash or sha256:<hex>");

export const ociDigestPattern = /^sha256:[0-9a-f]{64}$/i;
export const ociDigestSchema = z
  .string()
  .regex(ociDigestPattern, "Must be a valid OCI container digest in the form sha256:<64-hex>");

// Canonical Snapshot Verification Model (Section 5.1 of Master Plan)
export const snapshotVerificationStatusSchema = z
  .enum(["PASS", "FAIL", "ERROR"])
  .nullable();

export const snapshotVerificationSchema = z.object({
  status: snapshotVerificationStatusSchema,
  reward: z.number().finite().nullable(),
  verifierOutputHash: sha256HexSchema.nullable(),
});

export type SnapshotVerificationData = z.infer<typeof snapshotVerificationSchema>;

// Runtime Qualification Matrix (Section 4.1 of Master Plan)
export const runtimeCapabilityMatrixSchema = z.object({
  runtimeId: z.string().min(1),
  nativeStopSignal: z.string().min(1),
  claimExtractionMethod: z.string().min(1),
  sessionResumeSupported: z.boolean(),
  structuredFeedbackSupported: z.boolean(),
  usageTelemetrySupported: z.boolean(),
  trajectoryFormat: z.string().min(1),
  adapterVersion: z.string().min(1),
});

export type RuntimeCapabilityMatrixData = z.infer<typeof runtimeCapabilityMatrixSchema>;

// Canonical Failure Taxonomy (Section 4.4 of Master Plan)
export const trialFailureClassificationSchema = z.enum([
  "EXOGENOUS_INFRASTRUCTURE_FAILURE",
  "AGENT_RUNTIME_FAILURE",
  "GOVERNANCE_FAILURE",
  "VERIFIER_FAILURE",
]);

export type TrialFailureClassificationData = z.infer<
  typeof trialFailureClassificationSchema
>;

// Backwards-compatible G0 Trial Record schemas
export const g0VerificationStatusSchema = z.enum([
  "verified",
  "unverified",
  "not_applicable",
]);

export const g0SnapshotVerificationSchema = z.object({
  status: g0VerificationStatusSchema,
  requestedRef: z.string().min(1).nullable(),
  resolvedCommit: z.string().min(7).nullable(),
  reason: z.string().min(1).nullable(),
});

export const runtimeCapabilityTypeSchema = z.enum([
  "stop_signal",
  "claim_extraction",
  "session_resume",
  "feedback_injection",
  "usage_telemetry",
  "trajectory_recording",
]);

export const runtimeCapabilitySchema = z.object({
  capability: runtimeCapabilityTypeSchema,
  status: g0VerificationStatusSchema,
  evidence: z.string().min(1).nullable(),
});

export const claimMetricsSchema = z.object({
  taskSuccess: nullableMetricSchema.refine(
    (value) => value === null || value <= 1,
    "taskSuccess must be between 0 and 1",
  ),
  wallClockSeconds: nullableMetricSchema,
  inputTokens: nullableMetricSchema,
  outputTokens: nullableMetricSchema,
  estimatedCostUsd: nullableMetricSchema,
});

export const infrastructureFailureCategorySchema = z.enum([
  "CONTAINER_CRASH",
  "HARNESS_CRASH",
  "NETWORK_TIMEOUT",
  "OUT_OF_MEMORY",
  "DISK_EXHAUSTION",
  "ORACLE_TIMEOUT",
  "UNKNOWN",
]);

export const infrastructureFailureSchema = z.object({
  category: infrastructureFailureCategorySchema,
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const trialRecordSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    trialId: z.string().min(1),
    taskClusterId: z.string().min(1),
    taskId: z.string().min(1),
    arm: z.enum(["baseline", "treatment"]),
    repetition: z.number().int().nonnegative(),
    seed: z.number().int().nonnegative(),
    startedAt: z.iso.datetime(),
    finishedAt: z.iso.datetime(),
    status: z.enum(["completed", "infrastructure_failure", "invalid"]),
    harnessVersion: z.string().min(1),
    benchmarkCommit: z.string().min(7),
    subjectSnapshot: g0SnapshotVerificationSchema,
    runtimeCapabilities: z.array(runtimeCapabilitySchema),
    metrics: claimMetricsSchema,
    infrastructureFailure: infrastructureFailureSchema.nullable(),
    failureClassification: trialFailureClassificationSchema.optional().nullable(),
    evidencePaths: z.array(z.string().min(1)),
  })
  .superRefine((trial, context) => {
    const isInfrastructureFailure = trial.status === "infrastructure_failure";
    if (isInfrastructureFailure !== (trial.infrastructureFailure !== null)) {
      context.addIssue({
        code: "custom",
        path: ["infrastructureFailure"],
        message:
          "infrastructureFailure must be present exactly when status is infrastructure_failure",
      });
    }
  });

export type TrialRecordData = z.infer<typeof trialRecordSchema>;

// Canonical Experimental Model (H1 Apparatus)
export const completionClaimVerdictSchema = z.enum([
  "PASS",
  "BLOCK",
  "NOT_EVALUATED",
]);

export const completionClaimSchema = z.object({
  claimIndex: z.number().int().nonnegative(),
  timestamp: z.iso.datetime(),
  workspaceHash: sha256HexSchema,
  claimSnapshotId: sha256HexSchema,
  gateTriggered: z.string().min(1).nullable(),
  gateVerdict: completionClaimVerdictSchema,
  failureReasons: z.array(z.string().min(1)).optional(),
  recoveryTriggered: z.boolean(),
  promptTokensAtClaim: z.number().int().nonnegative().nullable(),
  snapshotVerification: snapshotVerificationSchema,
});

export type CompletionClaimData = z.infer<typeof completionClaimSchema>;

export const benchmarkTrialArmSchema = z.enum([
  "A0_baseline",
  "A1_observing",
  "A2_blocking",
  "A3_recovering",
]);

export const benchmarkTrialStopReasonSchema = z.enum([
  "agent_declared_done",
  "gate_blocked_exhausted",
  "timeout",
  "error",
  "unclaimed_failure",
]);

export const benchmarkTrialTaskSchema = z.object({
  id: z.string().min(1),
  benchmark: z.literal("terminal-bench"),
  benchmarkVersion: z.string().min(1),
  taskHash: sha256HexSchema,
});

export const benchmarkTrialReproducibilitySchema = z.object({
  configHash: sha256HexSchema,
  promptHash: sha256HexSchema,
  containerDigest: ociDigestSchema,
});

// Artifact-bound provenance (R5): hashes are persisted only alongside a
// verifiable artefact reference. Bare hashes are rejected upstream.
export const artifactProvenanceKindSchema = z.enum([
  "prompt-bytes",
  "container-manifest",
  "workspace-snapshot",
]);

export const artifactProvenanceRefSchema = z.object({
  kind: artifactProvenanceKindSchema,
  originPath: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
});

export type ArtifactProvenanceRefData = z.infer<typeof artifactProvenanceRefSchema>;

export const benchmarkTrialProvenanceSchema = z.object({
  prompt: artifactProvenanceRefSchema.refine((ref) => ref.kind === "prompt-bytes", {
    message: 'provenance.prompt.kind must be "prompt-bytes"',
  }),
  container: artifactProvenanceRefSchema.refine((ref) => ref.kind === "container-manifest", {
    message: 'provenance.container.kind must be "container-manifest"',
  }),
  workspaceSnapshot: artifactProvenanceRefSchema.refine(
    (ref) => ref.kind === "workspace-snapshot",
    { message: 'provenance.workspaceSnapshot.kind must be "workspace-snapshot"' },
  ),
});

export type BenchmarkTrialProvenanceData = z.infer<typeof benchmarkTrialProvenanceSchema>;

// Native Harbor correlation (R5 single-run session, R6 live container facts).
export const benchmarkTrialHarborCorrelationSchema = z.object({
  jobId: z.string().uuid(),
  trialId: z.string().uuid(),
  trialName: z.string().min(1),
  resultPath: z.string().min(1),
  resultHash: sha256HexSchema,
  containerId: z.string().min(1),
  containerDigest: ociDigestSchema,
});

export type BenchmarkTrialHarborCorrelationData = z.infer<
  typeof benchmarkTrialHarborCorrelationSchema
>;

export const benchmarkTrialExecutionSchema = z.object({
  runtimeId: z.string().min(1),
  runtimeVersion: z.string().min(1),
  model: z.string().min(1),
  modelTemperature: z.number().finite().nullable(),
  runtimeRunId: z.string().min(1),
  workspaceId: z.string().min(1),
  claims: z.array(completionClaimSchema),
  finalStopReason: benchmarkTrialStopReasonSchema,
  totalRecoveryCount: z.number().int().nonnegative(),
});

export const benchmarkTrialVerifierSchema = z.object({
  authority: z.literal("harbor-task-verifier"),
  passed: z.boolean(),
  reward: z.number().finite(),
  durationMs: z.number().finite().nonnegative(),
  verifierOutputHash: sha256HexSchema,
});

export const benchmarkTrialMetricsSchema = z.object({
  falseCompletionInitial: z.boolean().nullable(),
  falseCompletionTerminal: z.boolean().nullable(),
  falseCompletionIntercepted: z.boolean().nullable(),
  recoverySuccessful: z.boolean().nullable(),
});

export const benchmarkTrialUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  costUsd: z.number().finite().nonnegative().nullable(),
  durationMs: z.number().finite().nonnegative(),
});

export const harborDistributionIdentitySchema = z.enum([
  "wheel-verified",
  "cli-shape-only",
]);

export type HarborDistributionIdentityData = z.infer<typeof harborDistributionIdentitySchema>;

export const benchmarkTrialSchema = z
  .object({
    experimentId: z.string().min(1),
    hypothesisId: z.string().min(1),
    trialId: z.string().min(1),
    campaignId: z.string().min(1),
    arm: benchmarkTrialArmSchema,
    repetitionIndex: z.number().int().nonnegative(),
    task: benchmarkTrialTaskSchema,
    reproducibility: benchmarkTrialReproducibilitySchema,
    provenance: benchmarkTrialProvenanceSchema,
    harbor: benchmarkTrialHarborCorrelationSchema.nullable(),
    distribution: harborDistributionIdentitySchema,
    execution: benchmarkTrialExecutionSchema,
    verifier: benchmarkTrialVerifierSchema.nullable(),
    failureClassification: trialFailureClassificationSchema.nullable(),
    metrics: benchmarkTrialMetricsSchema,
    usage: benchmarkTrialUsageSchema,
  })
  .refine(
    (trial) => {
      // If verifier is null (trial failed/aborted without verifier), failureClassification must be provided
      if (trial.verifier === null) {
        return trial.failureClassification !== null;
      }
      // If verifier is present (trial completed evaluation), failureClassification must be null
      return trial.failureClassification === null;
    },
    {
      message:
        "Mutual exclusivity violated: failureClassification must be null when verifier is present, and non-null when verifier is null.",
      path: ["failureClassification"],
    },
  );

export type BenchmarkTrialData = z.infer<typeof benchmarkTrialSchema>;
