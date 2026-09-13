import { z } from "zod";

export const gateVerdictSchema = z.enum(["PASS", "FAIL"]);

export const gateCheckResultSchema = z.object({
  id: z.string().min(1),
  verdict: gateVerdictSchema,
  evidence: z.array(z.string().min(1)),
  message: z.string().min(1),
});

export const gateEvaluationResultSchema = z.object({
  gateId: z.string().min(1),
  verdict: gateVerdictSchema,
  evaluatedAt: z.iso.datetime(),
  checks: z.array(gateCheckResultSchema).min(1),
});

export type GateEvaluationResultData = z.infer<
  typeof gateEvaluationResultSchema
>;
