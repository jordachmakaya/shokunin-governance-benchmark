import { z } from "zod";
import type {
  EvalReport,
  ArmSuccessMetrics,
  AttritionRecord,
  BcaBootstrapConfig,
  PairedComparisonResult,
  IntentionToTreatResult,
  SensitivityAnalysisResult,
} from "../contracts/evals.contract.js";

// ---------------------------------------------------------------------------
// Bootstrap config schema
// ---------------------------------------------------------------------------

export const bcaBootstrapConfigSchema = z
  .object({
    resamples: z
      .number()
      .int()
      .min(10000, "Minimum 10 000 resamples required per master plan §6.3"),
    seed: z.string().min(1, "Seed must be a non-empty string"),
    confidenceLevel: z
      .number()
      .gt(0)
      .lt(1, "confidenceLevel must be strictly between 0 and 1"),
    alternative: z.literal("two-sided"),
  })
  .strict();

export type BcaBootstrapConfigData = z.infer<typeof bcaBootstrapConfigSchema>;

// ---------------------------------------------------------------------------
// Attrition record schema
// ---------------------------------------------------------------------------

export const attritionReasonSchema = z.enum([
  "MISSING_PAIR",
  "INFRASTRUCTURE_FAILURE",
  "AGENT_RUNTIME_FAILURE",
  "VERIFIER_FAILURE",
  "GOVERNANCE_FAILURE",
  "INCOMPLETE_METRICS",
]);

export const attritionRecordSchema = z
  .object({
    pairingKey: z.string().min(1),
    arm: z.enum(["A0_baseline", "A1_observing", "A2_blocking", "A3_recovering"]),
    reason: attritionReasonSchema,
    failureClassification: z
      .enum([
        "EXOGENOUS_INFRASTRUCTURE_FAILURE",
        "AGENT_RUNTIME_FAILURE",
        "GOVERNANCE_FAILURE",
        "VERIFIER_FAILURE",
      ])
      .nullable(),
    trialId: z.string().nullable(),
  })
  .strict();

export type AttritionRecordData = z.infer<typeof attritionRecordSchema>;

// ---------------------------------------------------------------------------
// Arm success metrics schema
// ---------------------------------------------------------------------------

export const armSuccessMetricsSchema = z
  .object({
    arm: z.enum(["A0_baseline", "A1_observing", "A2_blocking", "A3_recovering"]),
    trialsIncluded: z.number().int().nonnegative(),
    trialsExcluded: z.number().int().nonnegative(),
    successRate: z.number().min(0).max(1),
    falseCompletionTerminalRate: z.number().min(0).max(1).nullable(),
    meanInputTokens: z.number().nonnegative().nullable(),
    meanOutputTokens: z.number().nonnegative().nullable(),
    meanCostUsd: z.number().nonnegative().nullable(),
    medianDurationMs: z.number().nonnegative(),
    gateDetectionRate: z.number().min(0).max(1).nullable(),
    recoverySuccessRate: z.number().min(0).max(1).nullable(),
    falseCompletionInterceptedRate: z.number().min(0).max(1).nullable(),
  })
  .strict();

export type ArmSuccessMetricsData = z.infer<typeof armSuccessMetricsSchema>;

// ---------------------------------------------------------------------------
// Paired comparison result schema
// ---------------------------------------------------------------------------

export const pairedComparisonResultSchema = z
  .object({
    deltaSuccessRate: z.number().finite(),
    ciLow: z.number().finite(),
    ciHigh: z.number().finite(),
    sampleSizePairs: z.number().int().nonnegative(),
    taskClusterCount: z.number().int().nonnegative(),
    pValueTwoSided: z.number().min(0).max(1),
    z0: z.number().finite(),
    accelerationA: z.number().finite(),
    seed: z.string().min(1),
    inputHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "inputHash must be a 64-char hex SHA-256"),
  })
  .strict();

export type PairedComparisonResultData = z.infer<
  typeof pairedComparisonResultSchema
>;

/**
 * Optional publication metadata attached by the orchestration CLI.  It is
 * deliberately separate from the statistical report contract so that adding
 * provenance does not silently change any estimand or metric field.
 */
export const evalReportMetadataSchema = z
  .object({
    experimentId: z.string().min(1),
    hypothesisId: z.string().min(1),
    benchmark: z.string().min(1),
    benchmarkVersion: z.string().min(1),
    target: z.string().min(1),
    targetPainPoints: z.array(z.string().min(1)).min(1),
    arms: z.array(z.enum(["A0_baseline", "A1_observing", "A2_blocking", "A3_recovering"])).min(1),
    plannedDesign: z.string().min(1),
    estimandStatus: z.string().min(1),
    oracle: z.string().min(1),
  })
  .strict();

// ---------------------------------------------------------------------------
// EvalReport schema (serializable form — Maps replaced by arrays of entries)
// ---------------------------------------------------------------------------

export const evalReportSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    experimentId: z.string().min(1),
    hypothesisId: z.string().min(1),
    campaignId: z.string().min(1),
    generatedAt: z.iso.datetime(),
    trialsInput: z.number().int().nonnegative(),
    bootstrapConfig: bcaBootstrapConfigSchema,
    armMetrics: z.array(armSuccessMetricsSchema),
    attrition: z.array(attritionRecordSchema),
    /**
     * Serialized as array of [key, value] pairs to avoid Map serialization issues.
     */
    pairedComparisons: z.array(
      z.tuple([z.string(), pairedComparisonResultSchema]),
    ),
    intentionToTreat: z.array(
      z
        .object({
          arm: z.enum([
            "A0_baseline",
            "A1_observing",
            "A2_blocking",
            "A3_recovering",
          ]),
          totalTrialsAssigned: z.number().int().nonnegative(),
          successRate: z.number().min(0).max(1),
          attritionRate: z.number().min(0).max(1),
          attritionByReason: z.array(z.tuple([attritionReasonSchema, z.number().int().nonnegative()])),
        })
        .strict(),
    ),
    sensitivityAnalysis: z.array(
      z.tuple([
        z.string(),
        z
          .object({
            excludingInfraFailures: pairedComparisonResultSchema,
            includingInfraFailures: pairedComparisonResultSchema,
          })
          .strict(),
      ]),
    ),
    metadata: evalReportMetadataSchema.optional(),
  })
  .strict();

export type EvalReportData = z.infer<typeof evalReportSchema>;
