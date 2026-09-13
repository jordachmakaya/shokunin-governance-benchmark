/**
 * Durable session ledger (R6 item 7): job STARTED is appended under lock
 * BEFORE any execution, then every trial appends its terminal transition.
 * A STARTED job without matching terminals proves a crash/attrition instead
 * of silently losing attempts.
 */
export type SessionLedgerEventType =
  | "STARTED"
  | "SESSION_COMPLETED"
  | "SESSION_FAILED"
  | "TRIAL_COMPLETED"
  | "TRIAL_BLOCKED"
  | "TRIAL_QUARANTINED"
  | "TRIAL_FAILED";

export interface SessionLedgerEvent {
  readonly event: SessionLedgerEventType;
  /** "job" for session-scope entries, "trial" for per-trial transitions. */
  readonly scope: "job" | "trial";
  readonly jobName: string;
  readonly trialId?: string | undefined;
  readonly timestamp: string;
  readonly detail?: Record<string, unknown> | undefined;
}
