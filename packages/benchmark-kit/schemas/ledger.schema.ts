import { z } from "zod";

export const sessionLedgerEventTypeSchema = z.enum([
  "STARTED",
  "SESSION_COMPLETED",
  "SESSION_FAILED",
  "TRIAL_COMPLETED",
  "TRIAL_BLOCKED",
  "TRIAL_QUARANTINED",
  "TRIAL_FAILED",
]);

export const sessionLedgerEventSchema = z.object({
  event: sessionLedgerEventTypeSchema,
  scope: z.enum(["job", "trial"]),
  jobName: z.string().min(1),
  trialId: z.string().min(1).optional(),
  timestamp: z.iso.datetime(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export type SessionLedgerEventData = z.infer<typeof sessionLedgerEventSchema>;
