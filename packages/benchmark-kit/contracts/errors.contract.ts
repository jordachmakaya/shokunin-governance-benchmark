export type BenchmarkErrorCode =
  | "CONFIG_INVALID"
  | "HARNESS_UNAVAILABLE"
  | "INFRASTRUCTURE_FAILURE"
  | "TRIAL_TIMEOUT"
  | "RESULT_INVALID"
  | "POLICY_VIOLATION";

export interface BenchmarkErrorShape {
  readonly code: BenchmarkErrorCode;
  readonly message: string;
  readonly remediation: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}
