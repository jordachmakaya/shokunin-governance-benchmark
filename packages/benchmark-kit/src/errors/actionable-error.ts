import type {
  BenchmarkErrorCode,
  BenchmarkErrorShape,
} from "../../contracts/errors.contract.js";

export class ActionableBenchmarkError extends Error implements BenchmarkErrorShape {
  public readonly code: BenchmarkErrorCode;
  public readonly remediation: string;
  public readonly retryable: boolean;
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(shape: BenchmarkErrorShape) {
    super(`[${shape.code}] ${shape.message}`);
    this.name = "ActionableBenchmarkError";
    this.code = shape.code;
    this.remediation = shape.remediation;
    this.retryable = shape.retryable;
    if (shape.details !== undefined) {
      this.details = shape.details;
    }
  }

  public toJSON(): BenchmarkErrorShape {
    const rawMessage = this.message.replace(
      new RegExp(`^\\[${this.code}\\]\\s*`),
      "",
    );
    const result: BenchmarkErrorShape = {
      code: this.code,
      message: rawMessage,
      remediation: this.remediation,
      retryable: this.retryable,
    };
    if (this.details !== undefined) {
      return { ...result, details: this.details };
    }
    return result;
  }
}
