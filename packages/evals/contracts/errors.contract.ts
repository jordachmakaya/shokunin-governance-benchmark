/**
 * ZB3 — Actionable error contract for the evals engine.
 * Mirrors the style of ZB2 ActionableBenchmarkError.
 */

export type EvalsErrorCode =
  | "INPUT_INVALID"         // Trials array fails structural validation
  | "CAMPAIGN_MISMATCH"     // Trials span multiple campaignIds without explicit multi-campaign flag
  | "CONFIG_INVALID"        // BcaBootstrapConfig violates invariants (e.g. resamples < 10000)
  | "INSUFFICIENT_PAIRS"    // No matched pairs found for primary analysis
  | "COMPUTATION_FAILED";   // Internal computation error (bug — please report)

export interface ActionableEvalsErrorOptions {
  readonly code: EvalsErrorCode;
  readonly message: string;
  readonly remediation: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export class ActionableEvalsError extends Error {
  readonly code: EvalsErrorCode;
  readonly remediation: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(options: ActionableEvalsErrorOptions) {
    super(options.message);
    this.name = "ActionableEvalsError";
    this.code = options.code;
    this.remediation = options.remediation;
    this.retryable = options.retryable;
    this.details = options.details;
  }
}
