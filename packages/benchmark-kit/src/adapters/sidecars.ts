import { z } from "zod";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";
import { ociDigestSchema, sha256HexSchema } from "../../schemas/trial.schema.js";

/**
 * @fileoverview Strict bridge-sidecar contracts (ZB2.2-R8).
 *
 * R7 validated sidecars by presence (parseable JSON counted as proof):
 * `declaredDone:false` became a valid claim, and substring-matched
 * exceptions plus unread markers became valid A2 blocks. Every parser here
 * enforces exact values, exact trial binding, and cross-file coherence.
 * Malformed sidecars return null (absent) so downstream paths quarantine
 * instead of trusting them.
 */

export const claimSidecarSchema = z.object({
  declaredDone: z.literal(true),
  observedAt: z.iso.datetime(),
  trialName: z.string().min(1),
});
export type ClaimSidecar = z.infer<typeof claimSidecarSchema>;

export const outcomeSidecarSchema = z.object({
  declaredDone: z.literal(false),
  reason: z.enum(["agent_timeout", "agent_error"]),
  message: z.string().optional(),
  observedAt: z.iso.datetime(),
  trialName: z.string().min(1),
});
export type OutcomeSidecar = z.infer<typeof outcomeSidecarSchema>;

export const gateRequestSidecarSchema = z.object({
  trialName: z.string().min(1),
  arm: z.enum(["A1_observing", "A2_blocking", "A3_recovering"]),
  snapshotDir: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type GateRequestSidecar = z.infer<typeof gateRequestSidecarSchema>;

export const recoveryEventSidecarSchema = z.object({
  attempt: z.number().int().min(1).max(4),
  gateVerdict: z.enum(["PASS", "BLOCK"]),
  action: z.enum(["retry", "continue", "exhausted"]),
  at: z.iso.datetime(),
});
export const recoveryEventsSidecarSchema = z.array(recoveryEventSidecarSchema).min(1).max(4).superRefine((events, context) => {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.attempt !== index + 1) context.addIssue({ code: "custom", message: "Recovery attempts must be contiguous and ordered", path: [index, "attempt"] });
    if (index > 0 && events[index - 1]!.action === "continue") context.addIssue({ code: "custom", message: "No events may follow successful recovery", path: [index] });
    if (event.action === "retry" && event.gateVerdict !== "BLOCK") context.addIssue({ code: "custom", message: "Retry requires BLOCK", path: [index] });
    if (event.action === "continue" && event.gateVerdict !== "PASS") context.addIssue({ code: "custom", message: "Continue requires PASS", path: [index] });
    if (event.action === "exhausted" && event.gateVerdict !== "BLOCK") context.addIssue({ code: "custom", message: "Exhaustion requires BLOCK", path: [index] });
    if (event.action === "exhausted" && event.attempt !== 4) context.addIssue({ code: "custom", message: "Exhaustion is valid only after three retries", path: [index, "attempt"] });
  }
  if (events.length > 0) {
    const terminal = events[events.length - 1]!;
    if (terminal.action !== "continue" && terminal.action !== "exhausted") context.addIssue({ code: "custom", message: "Recovery history must end in continue or exhausted", path: [events.length - 1, "action"] });
    if (terminal.action === "continue" && terminal.gateVerdict !== "PASS") context.addIssue({ code: "custom", message: "Successful recovery must end with PASS", path: [events.length - 1] });
    if (terminal.action === "exhausted" && terminal.gateVerdict !== "BLOCK") context.addIssue({ code: "custom", message: "Exhaustion must end with BLOCK", path: [events.length - 1] });
    if (terminal.action === "exhausted" && events.slice(0, -1).some((event) => event.action !== "retry")) context.addIssue({ code: "custom", message: "Exhaustion requires only preceding retries", path: [events.length - 1] });
  }
});

export const gateVerdictSidecarSchema = z.object({
  verdict: z.enum(["PASS", "BLOCK"]),
  failureReasons: z.array(z.string()),
  checks: z.array(z.object({
    id: z.string().min(1),
    verdict: z.enum(["PASS", "FAIL"]),
    evidence: z.array(z.string()),
    message: z.string(),
  })),
  evaluatedAt: z.iso.datetime(),
  gateId: z.string().min(1),
  snapshotHash: sha256HexSchema.nullable(),
});
export type GateVerdictSidecar = z.infer<typeof gateVerdictSidecarSchema>;

export const gateBlockedSidecarSchema = z.object({
  trialName: z.string().min(1),
  at: z.iso.datetime(),
  verdict: z.object({ verdict: z.literal("BLOCK") }).passthrough(),
});
export type GateBlockedSidecar = z.infer<typeof gateBlockedSidecarSchema>;

export const containerIdentitySidecarSchema = z.object({
  containerId: z.string().min(1),
  containerName: z.string().min(1),
  imageId: ociDigestSchema,
  imageRef: z.string().nullable(),
  repoDigests: z.array(z.string()),
  inspectedAt: z.iso.datetime(),
});
export type ContainerIdentitySidecar = z.infer<typeof containerIdentitySidecarSchema>;

export const exportManifestSidecarSchema = z.object({
  exported: z.array(z.string()),
  missing: z.array(z.string()),
  at: z.iso.datetime(),
});
export type ExportManifestSidecar = z.infer<typeof exportManifestSidecarSchema>;

/** Strict-parse a sidecar value; null when absent or malformed. */
export function parseSidecar<T>(schema: z.ZodType<T>, value: unknown): T | null {
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function failSidecar(file: string, detail: string): never {
  throw new ActionableBenchmarkError({
    code: "RESULT_INVALID",
    message: `Bridge sidecar rejected: ${file}: ${detail}.`,
    remediation: "Sidecars are produced by the lab-owned bridge agent; malformed sidecars indicate tampering or a protocol breach.",
    retryable: false,
    details: { file, detail },
  });
}

export interface GateBlockProof {
  readonly proven: boolean;
  readonly reason: string;
}

/**
 * Strict A2 prevention proof (R8 item 2). ALL of the following must hold:
 * - the Harbor exception type is EXACTLY "ShokuninGateBlocked" (no substring);
 * - gate-blocked.json strictly parses;
 * - the marker names EXACTLY this trial;
 * - the marker's internal verdict is BLOCK;
 * - gate-verdict.json strictly parses with verdict BLOCK.
 * Anything else is not a proven block (caller decides: reject or quarantine).
 */
export function isProvenGateBlock(args: {
  trialName: string;
  exceptionType: unknown;
  blockedRaw: unknown;
  verdictRaw: unknown;
}): GateBlockProof {
  if (args.exceptionType !== "ShokuninGateBlocked") {
    return { proven: false, reason: `exception_type is ${JSON.stringify(args.exceptionType) ?? "absent"}, not exactly "ShokuninGateBlocked"` };
  }
  if (args.blockedRaw === null || args.blockedRaw === undefined) {
    return { proven: false, reason: "gate-blocked.json marker is absent" };
  }
  const marker = gateBlockedSidecarSchema.safeParse(args.blockedRaw);
  if (!marker.success) {
    return { proven: false, reason: "gate-blocked.json marker is malformed" };
  }
  if (marker.data.trialName !== args.trialName) {
    return { proven: false, reason: `marker trialName "${marker.data.trialName}" does not exactly match trial "${args.trialName}"` };
  }
  if (args.verdictRaw === null || args.verdictRaw === undefined) {
    return { proven: false, reason: "gate-verdict.json is absent, cannot corroborate the marker" };
  }
  const verdict = gateVerdictSidecarSchema.safeParse(args.verdictRaw);
  if (!verdict.success) {
    return { proven: false, reason: "gate-verdict.json is malformed" };
  }
  if (verdict.data.verdict !== "BLOCK") {
    return { proven: false, reason: `gate verdict is "${verdict.data.verdict}", contradicting the BLOCK marker` };
  }
  return { proven: true, reason: "exact exception, exact trial marker with internal BLOCK, corroborating BLOCK verdict" };
}
