export type ActionableErrorCode =
  | "INVALID_INPUT"
  | "OUT_OF_SCOPE"
  | "PROCESS_FAILED"
  | "TIMEOUT"
  | "INVARIANT_VIOLATION";

export interface ActionableErrorShape {
  readonly code: ActionableErrorCode;
  readonly message: string;
  readonly remediation: string;
  readonly cause?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}
