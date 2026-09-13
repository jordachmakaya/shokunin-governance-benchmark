import assert from "node:assert/strict";
import test from "node:test";
import {
  benchmarkTrialSchema,
  benchmarkTrialStopReasonSchema,
  completionClaimSchema,
  infrastructureFailureCategorySchema,
  infrastructureFailureSchema,
  runtimeCapabilityMatrixSchema,
  runtimeCapabilitySchema,
  snapshotVerificationSchema,
  trialFailureClassificationSchema,
  trialRecordSchema,
} from "../schemas/trial.schema.js";
import type {
  CompletedBenchmarkTrial,
  FailedBenchmarkTrial,
} from "../contracts/trial.contract.js";

const validSha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const validOciDigest = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

test("BLOCKER 1: completionClaimSchema accepts A0 claim with gateTriggered null and NOT_EVALUATED", () => {
  const a0Claim = {
    claimIndex: 0,
    claimSnapshotId: validSha256,
    timestamp: "2026-09-08T12:00:00.000Z",
    workspaceHash: validSha256,
    gateTriggered: null,
    gateVerdict: "NOT_EVALUATED" as const,
    failureReasons: [],
    recoveryTriggered: false,
    promptTokensAtClaim: 1200,
    snapshotVerification: {
      status: null,
      reward: null,
      verifierOutputHash: null,
    },
  };

  const parsed = completionClaimSchema.parse(a0Claim);
  assert.equal(parsed.claimIndex, 0);
  assert.equal(parsed.gateTriggered, null);
  assert.equal(parsed.gateVerdict, "NOT_EVALUATED");
  assert.equal(parsed.claimSnapshotId, validSha256);
  assert.equal(parsed.snapshotVerification.status, null);
  assert.equal(parsed.snapshotVerification.reward, null);
});

test("BLOCKER 1: benchmarkTrialSchema accepts trial with canonical claims and metrics", () => {
  const trialWithCanonicalClaimsAndMetrics = {
    experimentId: "exp-001",
    hypothesisId: "H1",
    trialId: "trial-abc-123",
    campaignId: "pilot-campaign",
    arm: "A0_baseline" as const,
    repetitionIndex: 0,
    task: {
      id: "task-42",
      benchmark: "terminal-bench" as const,
      benchmarkVersion: "1.0.0",
      taskHash: validSha256,
    },
    reproducibility: {
      configHash: validSha256,
      promptHash: validSha256,
      containerDigest: validOciDigest,
    },
    provenance: {
      prompt: { kind: "prompt-bytes" as const, originPath: "<inline-prompt>", byteLength: 12, sha256: validSha256 },
      container: { kind: "container-manifest" as const, originPath: "job-config.yaml", byteLength: 100, sha256: validSha256 },
      workspaceSnapshot: { kind: "workspace-snapshot" as const, originPath: "harbor-trial:trial-1", byteLength: 50, sha256: validSha256 },
    },
    harbor: {
      jobId: "a1234567-1234-4123-a123-123456789012",
      trialId: "b1234567-1234-4123-b123-123456789012",
      trialName: "trial-1",
      resultPath: "/jobs/oracle-job/trial-1/result.json",
      resultHash: validSha256,
      containerId: "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      containerDigest: validOciDigest,
    },
    distribution: "cli-shape-only" as const,
    execution: {
      runtimeId: "codex",
      runtimeVersion: "0.1.0",
      model: "gpt-4o",
      modelTemperature: null,
      runtimeRunId: "b1234567-1234-4123-b123-123456789012",
      workspaceId: "trial-1",
      claims: [
        {
          claimIndex: 0,
          claimSnapshotId: validSha256,
          timestamp: "2026-09-08T12:00:01.000Z",
          workspaceHash: validSha256,
          gateTriggered: null,
          gateVerdict: "NOT_EVALUATED" as const,
          recoveryTriggered: false,
          promptTokensAtClaim: 1000,
          snapshotVerification: {
            status: "PASS" as const,
            reward: 1,
            verifierOutputHash: validSha256,
          },
        },
      ],
      finalStopReason: "agent_declared_done" as const,
      totalRecoveryCount: 0,
    },
    verifier: {
      authority: "harbor-task-verifier" as const,
      passed: true,
      reward: 1,
      durationMs: 450,
      verifierOutputHash: validSha256,
    },
    failureClassification: null,
    metrics: {
      falseCompletionInitial: null,
      falseCompletionTerminal: false,
      falseCompletionIntercepted: null,
      recoverySuccessful: null,
    },
    usage: {
      inputTokens: 2000,
      outputTokens: 300,
      costUsd: 0.02,
      durationMs: 3500,
    },
  };

  const parsed = benchmarkTrialSchema.parse(trialWithCanonicalClaimsAndMetrics);
  assert.equal(parsed.arm, "A0_baseline");
  assert.equal(parsed.metrics.falseCompletionInitial, null);
  assert.equal(parsed.metrics.falseCompletionTerminal, false);
  assert.equal(parsed.metrics.recoverySuccessful, null);
  assert.equal(parsed.execution.claims[0]?.snapshotVerification.status, "PASS");
});

test("BLOCKER 2: runtimeCapabilitySchema rejects made_up_capability", () => {
  assert.throws(
    () => {
      runtimeCapabilitySchema.parse({
        capability: "made_up_capability",
        status: "verified",
        evidence: "fake",
      });
    },
    /invalid_value|invalid_enum|Invalid/,
  );

  // Accepts canonical capability
  const valid = runtimeCapabilitySchema.parse({
    capability: "stop_signal",
    status: "verified",
    evidence: "exit 0",
  });
  assert.equal(valid.capability, "stop_signal");
});

test("BLOCKER 2: infrastructureFailureSchema rejects MADE_UP_FAILURE", () => {
  assert.throws(
    () => {
      infrastructureFailureSchema.parse({
        category: "MADE_UP_FAILURE",
        message: "something exploded",
        retryable: true,
      });
    },
    /invalid_value|invalid_enum|Invalid/,
  );

  // Accepts canonical category
  const valid = infrastructureFailureSchema.parse({
    category: "CONTAINER_CRASH",
    message: "OOM killed",
    retryable: true,
  });
  assert.equal(valid.category, "CONTAINER_CRASH");
});

test("BLOCKER 2: rejects short or non-hex hashes and invalid digests", () => {
  assert.throws(() => {
    completionClaimSchema.parse({
      claimIndex: 0,
      claimSnapshotId: "x", // rejected!
      timestamp: "2026-09-08T12:00:00.000Z",
      workspaceHash: validSha256,
      gateTriggered: null,
      gateVerdict: "NOT_EVALUATED",
      recoveryTriggered: false,
      promptTokensAtClaim: null,
      snapshotVerification: {
        status: null,
        reward: null,
        verifierOutputHash: null,
      },
    });
  });

  assert.throws(() => {
    benchmarkTrialSchema.parse({
      experimentId: "exp-1",
      hypothesisId: "H1",
      trialId: "t-1",
      campaignId: "c-1",
      arm: "A0_baseline",
      repetitionIndex: 0,
      task: { id: "t", benchmark: "terminal-bench", benchmarkVersion: "1.0", taskHash: "x" }, // rejected!
      reproducibility: { configHash: "x", promptHash: "x", containerDigest: "x" }, // rejected!
      execution: {
        runtimeId: "r",
        runtimeVersion: "1",
        model: "m",
        modelTemperature: null,
      runtimeRunId: "b1234567-1234-4123-b123-123456789012",
      workspaceId: "trial-1",
        claims: [],
        finalStopReason: "agent_declared_done",
        totalRecoveryCount: 0,
      },
      verifier: { authority: "harbor-task-verifier", passed: true, reward: 1, durationMs: 10, verifierOutputHash: validSha256 },
      failureClassification: null,
      metrics: { falseCompletionInitial: null, falseCompletionTerminal: false, falseCompletionIntercepted: null, recoverySuccessful: null },
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 },
    });
  });
});

test("canonical contracts: snapshotVerificationSchema validates PASS/FAIL/ERROR/null status and hashes", () => {
  // PASS with reward and hash
  const pass = snapshotVerificationSchema.parse({
    status: "PASS",
    reward: 1.0,
    verifierOutputHash: validSha256,
  });
  assert.equal(pass.status, "PASS");
  assert.equal(pass.reward, 1.0);

  // FAIL with reward 0 and hash
  const fail = snapshotVerificationSchema.parse({
    status: "FAIL",
    reward: 0,
    verifierOutputHash: validSha256,
  });
  assert.equal(fail.status, "FAIL");

  // ERROR with null reward
  const error = snapshotVerificationSchema.parse({
    status: "ERROR",
    reward: null,
    verifierOutputHash: null,
  });
  assert.equal(error.status, "ERROR");

  // Unverified claim before parity proof
  const unverified = snapshotVerificationSchema.parse({
    status: null,
    reward: null,
    verifierOutputHash: null,
  });
  assert.equal(unverified.status, null);

  // Rejects invalid status
  assert.throws(() => {
    snapshotVerificationSchema.parse({
      status: "INVALID_STATUS",
      reward: null,
      verifierOutputHash: null,
    });
  });

  // Rejects non-hex or malformed hash
  assert.throws(() => {
    snapshotVerificationSchema.parse({
      status: "PASS",
      reward: 1.0,
      verifierOutputHash: "not-a-64-char-hex",
    });
  });
});

test("canonical contracts: falseCompletionTerminal accepts null when unverified and boolean when verified", () => {
  const trialBase = {
    experimentId: "exp-001",
    hypothesisId: "H1",
    trialId: "trial-abc-123",
    campaignId: "pilot-campaign",
    arm: "A0_baseline" as const,
    repetitionIndex: 0,
    task: {
      id: "task-42",
      benchmark: "terminal-bench" as const,
      benchmarkVersion: "1.0.0",
      taskHash: validSha256,
    },
    reproducibility: {
      configHash: validSha256,
      promptHash: validSha256,
      containerDigest: validOciDigest,
    },
    provenance: {
      prompt: { kind: "prompt-bytes" as const, originPath: "<inline-prompt>", byteLength: 12, sha256: validSha256 },
      container: { kind: "container-manifest" as const, originPath: "job-config.yaml", byteLength: 100, sha256: validSha256 },
      workspaceSnapshot: { kind: "workspace-snapshot" as const, originPath: "harbor-trial:trial-1", byteLength: 50, sha256: validSha256 },
    },
    harbor: {
      jobId: "a1234567-1234-4123-a123-123456789012",
      trialId: "b1234567-1234-4123-b123-123456789012",
      trialName: "trial-1",
      resultPath: "/jobs/oracle-job/trial-1/result.json",
      resultHash: validSha256,
      containerId: "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      containerDigest: validOciDigest,
    },
    distribution: "cli-shape-only" as const,
    execution: {
      runtimeId: "codex",
      runtimeVersion: "0.1.0",
      model: "gpt-4o",
      modelTemperature: null,
      runtimeRunId: "b1234567-1234-4123-b123-123456789012",
      workspaceId: "trial-1",
      claims: [],
      finalStopReason: "agent_declared_done" as const,
      totalRecoveryCount: 0,
    },
    verifier: {
      authority: "harbor-task-verifier" as const,
      passed: true,
      reward: 1,
      durationMs: 450,
      verifierOutputHash: validSha256,
    },
    usage: {
      inputTokens: 2000,
      outputTokens: 300,
      costUsd: 0.02,
      durationMs: 3500,
    },
    failureClassification: null,
  };

  // Accepts falseCompletionTerminal = null when unverified or blocked
  const nullTrial = benchmarkTrialSchema.parse({
    ...trialBase,
    metrics: {
      falseCompletionInitial: null,
      falseCompletionTerminal: null,
      falseCompletionIntercepted: null,
      recoverySuccessful: null,
    },
  });
  assert.equal(nullTrial.metrics.falseCompletionTerminal, null);

  // Accepts falseCompletionTerminal = true
  const trueTrial = benchmarkTrialSchema.parse({
    ...trialBase,
    metrics: {
      falseCompletionInitial: null,
      falseCompletionTerminal: true,
      falseCompletionIntercepted: null,
      recoverySuccessful: null,
    },
  });
  assert.equal(trueTrial.metrics.falseCompletionTerminal, true);

  // Accepts falseCompletionTerminal = false
  const falseTrial = benchmarkTrialSchema.parse({
    ...trialBase,
    metrics: {
      falseCompletionInitial: null,
      falseCompletionTerminal: false,
      falseCompletionIntercepted: null,
      recoverySuccessful: null,
    },
  });
  assert.equal(falseTrial.metrics.falseCompletionTerminal, false);
});

test("canonical contracts: benchmarkTrialSchema attaches failureClassification and records trials without verifier", () => {
  const trialBase = {
    experimentId: "exp-001",
    hypothesisId: "H1",
    trialId: "trial-abc-123",
    campaignId: "pilot-campaign",
    arm: "A0_baseline" as const,
    repetitionIndex: 0,
    task: {
      id: "task-42",
      benchmark: "terminal-bench" as const,
      benchmarkVersion: "1.0.0",
      taskHash: validSha256,
    },
    reproducibility: {
      configHash: validSha256,
      promptHash: validSha256,
      containerDigest: validOciDigest,
    },
    provenance: {
      prompt: { kind: "prompt-bytes" as const, originPath: "<inline-prompt>", byteLength: 12, sha256: validSha256 },
      container: { kind: "container-manifest" as const, originPath: "job-config.yaml", byteLength: 100, sha256: validSha256 },
      workspaceSnapshot: { kind: "workspace-snapshot" as const, originPath: "harbor-trial:trial-1", byteLength: 50, sha256: validSha256 },
    },
    harbor: {
      jobId: "a1234567-1234-4123-a123-123456789012",
      trialId: "b1234567-1234-4123-b123-123456789012",
      trialName: "trial-1",
      resultPath: "/jobs/oracle-job/trial-1/result.json",
      resultHash: validSha256,
      containerId: "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      containerDigest: validOciDigest,
    },
    distribution: "cli-shape-only" as const,
    execution: {
      runtimeId: "codex",
      runtimeVersion: "0.1.0",
      model: "gpt-4o",
      modelTemperature: null,
      runtimeRunId: "b1234567-1234-4123-b123-123456789012",
      workspaceId: "trial-1",
      claims: [],
      finalStopReason: "agent_declared_done" as const,
      totalRecoveryCount: 0,
    },
    verifier: {
      authority: "harbor-task-verifier" as const,
      passed: true,
      reward: 1,
      durationMs: 450,
      verifierOutputHash: validSha256,
    },
    failureClassification: null,
    metrics: {
      falseCompletionInitial: null,
      falseCompletionTerminal: false,
      falseCompletionIntercepted: null,
      recoverySuccessful: null,
    },
    usage: {
      inputTokens: 2000,
      outputTokens: 300,
      costUsd: 0.02,
      durationMs: 3500,
    },
  };

  // Case 1: Completed trial with verifier and null failureClassification
  const completedTrial = benchmarkTrialSchema.parse(trialBase);
  assert.equal(completedTrial.verifier?.passed, true);
  assert.equal(completedTrial.failureClassification, null);

  // Case 2: Failed/aborted trial without verifier (e.g. verifier crashed or harness aborted)
  const failedTrial = benchmarkTrialSchema.parse({
    ...trialBase,
    verifier: null,
    failureClassification: "VERIFIER_FAILURE",
  });
  assert.equal(failedTrial.verifier, null);
  assert.equal(failedTrial.failureClassification, "VERIFIER_FAILURE");

  // Case 3: Failed/aborted trial with GOVERNANCE_FAILURE
  const govTrial = benchmarkTrialSchema.parse({
    ...trialBase,
    verifier: null,
    failureClassification: "GOVERNANCE_FAILURE",
  });
  assert.equal(govTrial.failureClassification, "GOVERNANCE_FAILURE");

  // Case 4: Rejects trial when verifier is null AND failureClassification is null
  assert.throws(
    () => {
      benchmarkTrialSchema.parse({
        ...trialBase,
        verifier: null,
        failureClassification: null,
      });
    },
    /Mutual exclusivity violated: failureClassification must be null when verifier is present, and non-null when verifier is null./,
  );

  // Case 5: Rejects trial when verifier is present AND failureClassification is non-null
  assert.throws(
    () => {
      benchmarkTrialSchema.parse({
        ...trialBase,
        verifier: {
          authority: "harbor-task-verifier" as const,
          passed: true,
          reward: 1,
          durationMs: 450,
          verifierOutputHash: validSha256,
        },
        failureClassification: "VERIFIER_FAILURE",
      });
    },
    /Mutual exclusivity violated: failureClassification must be null when verifier is present, and non-null when verifier is null./,
  );
});

test("canonical contracts: benchmarkTrialStopReasonSchema strictly aligns with canonical stop reasons", () => {
  const canonicalReasons = [
    "agent_declared_done",
    "gate_blocked_exhausted",
    "timeout",
    "error",
    "unclaimed_failure",
  ] as const;

  for (const reason of canonicalReasons) {
    const parsed = benchmarkTrialStopReasonSchema.parse(reason);
    assert.equal(parsed, reason);
  }

  // Reject deprecated / divergent stop reasons fail-closed
  const rejectedReasons = [
    "max_turns_exceeded",
    "gate_abort",
    "infrastructure_error",
    "unknown_reason",
  ];

  for (const reason of rejectedReasons) {
    assert.throws(
      () => {
        benchmarkTrialStopReasonSchema.parse(reason);
      },
      /invalid_enum_value|Invalid input|Invalid option/,
    );
  }
});

test("canonical contracts: runtimeCapabilityMatrixSchema validates qualification matrix", () => {
  const matrix = {
    runtimeId: "codex",
    nativeStopSignal: "exit_code_zero",
    claimExtractionMethod: "hook_interception",
    sessionResumeSupported: true,
    structuredFeedbackSupported: true,
    usageTelemetrySupported: true,
    trajectoryFormat: "jsonl_messages",
    adapterVersion: "1.0.0",
  };
  const parsed = runtimeCapabilityMatrixSchema.parse(matrix);
  assert.equal(parsed.runtimeId, "codex");
  assert.equal(parsed.sessionResumeSupported, true);

  // Rejects missing required field
  const { trajectoryFormat: _t, ...missingField } = matrix;
  assert.throws(() => {
    runtimeCapabilityMatrixSchema.parse(missingField);
  });
});

test("canonical contracts: trialFailureClassificationSchema validates failure taxonomy", () => {
  const validTaxonomies = [
    "EXOGENOUS_INFRASTRUCTURE_FAILURE",
    "AGENT_RUNTIME_FAILURE",
    "GOVERNANCE_FAILURE",
    "VERIFIER_FAILURE",
  ] as const;

  for (const cat of validTaxonomies) {
    const parsed = trialFailureClassificationSchema.parse(cat);
    assert.equal(parsed, cat);
  }

  assert.throws(() => {
    trialFailureClassificationSchema.parse("UNKNOWN_FAILURE");
  });
});

test("trialRecordSchema enforces mutual exclusivity for infrastructureFailure", () => {
  const base = {
    schemaVersion: "1.0.0" as const,
    trialId: "t-001",
    taskClusterId: "cluster-1",
    taskId: "task-1",
    arm: "baseline" as const,
    repetition: 0,
    seed: 42,
    startedAt: "2026-09-08T10:00:00.000Z",
    finishedAt: "2026-09-08T10:00:05.000Z",
    harnessVersion: "1.0.0",
    benchmarkCommit: "abcdef1",
    subjectSnapshot: {
      status: "verified" as const,
      requestedRef: "main",
      resolvedCommit: "abcdef1",
      reason: null,
    },
    runtimeCapabilities: [
      { capability: "stop_signal" as const, status: "verified" as const, evidence: "exit 0" },
    ],
    metrics: {
      taskSuccess: 1,
      wallClockSeconds: 5,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.002,
    },
    evidencePaths: ["evidence/log.txt"],
  };

  const validCompleted = trialRecordSchema.parse({
    ...base,
    status: "completed" as const,
    infrastructureFailure: null,
  });
  assert.equal(validCompleted.status, "completed");

  const validInfraFailure = trialRecordSchema.parse({
    ...base,
    status: "infrastructure_failure" as const,
    infrastructureFailure: {
      category: "CONTAINER_CRASH" as const,
      message: "OOM killed container",
      retryable: true,
    },
  });
  assert.equal(validInfraFailure.status, "infrastructure_failure");

  assert.throws(() => {
    trialRecordSchema.parse({
      ...base,
      status: "completed" as const,
      infrastructureFailure: {
        category: "CONTAINER_CRASH" as const,
        message: "OOM",
        retryable: true,
      },
    });
  });
});

test("canonical contracts: CompletedBenchmarkTrial and FailedBenchmarkTrial strictly reflect mutual exclusivity", () => {
  const baseTrial = {
    experimentId: "exp-parity-01",
    hypothesisId: "H1",
    trialId: "trial-parity-01",
    campaignId: "pilot-campaign",
    arm: "A0_baseline" as const,
    repetitionIndex: 0,
    task: {
      id: "task-01",
      benchmark: "terminal-bench" as const,
      benchmarkVersion: "1.0.0",
      taskHash: validSha256,
    },
    reproducibility: {
      configHash: validSha256,
      promptHash: validSha256,
      containerDigest: validOciDigest,
    },
    provenance: {
      prompt: { kind: "prompt-bytes" as const, originPath: "<inline-prompt>", byteLength: 12, sha256: validSha256 },
      container: { kind: "container-manifest" as const, originPath: "job-config.yaml", byteLength: 100, sha256: validSha256 },
      workspaceSnapshot: { kind: "workspace-snapshot" as const, originPath: "harbor-trial:trial-1", byteLength: 50, sha256: validSha256 },
    },
    harbor: {
      jobId: "a1234567-1234-4123-a123-123456789012",
      trialId: "b1234567-1234-4123-b123-123456789012",
      trialName: "trial-1",
      resultPath: "/jobs/oracle-job/trial-1/result.json",
      resultHash: validSha256,
      containerId: "c0ffee1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
      containerDigest: validOciDigest,
    },
    distribution: "cli-shape-only" as const,
    execution: {
      runtimeId: "codex",
      runtimeVersion: "0.1.0",
      model: "gpt-4o",
      modelTemperature: null,
      runtimeRunId: "b1234567-1234-4123-b123-123456789012",
      workspaceId: "trial-1",
      claims: [],
      finalStopReason: "agent_declared_done" as const,
      totalRecoveryCount: 0,
    },
    metrics: {
      falseCompletionInitial: false,
      falseCompletionTerminal: false,
      falseCompletionIntercepted: false,
      recoverySuccessful: true,
    },
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
      durationMs: 1500,
    },
  };

  // Compile-time typing and runtime schema check for completed trial
  const completedTrial: CompletedBenchmarkTrial = {
    ...baseTrial,
    verifier: {
      authority: "harbor-task-verifier",
      passed: true,
      reward: 1.0,
      durationMs: 120,
      verifierOutputHash: validSha256,
    },
    failureClassification: null,
  };
  const parsedCompleted = benchmarkTrialSchema.parse(completedTrial);
  assert.notEqual(parsedCompleted.verifier, null);
  assert.equal(parsedCompleted.failureClassification, null);

  // Compile-time typing and runtime schema check for failed trial
  const failedTrial: FailedBenchmarkTrial = {
    ...baseTrial,
    verifier: null,
    failureClassification: "AGENT_RUNTIME_FAILURE" as const,
  };
  const parsedFailed = benchmarkTrialSchema.parse(failedTrial);
  assert.equal(parsedFailed.verifier, null);
  assert.notEqual(parsedFailed.failureClassification, null);

  // Reject both present
  assert.throws(() => {
    benchmarkTrialSchema.parse({
      ...baseTrial,
      verifier: completedTrial.verifier,
      failureClassification: failedTrial.failureClassification,
    });
  }, /Mutual exclusivity violated/);

  // Reject both null
  assert.throws(() => {
    benchmarkTrialSchema.parse({
      ...baseTrial,
      verifier: null,
      failureClassification: null,
    });
  }, /Mutual exclusivity violated/);
});
