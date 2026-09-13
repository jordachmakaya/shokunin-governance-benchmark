import type {
  ActionableErrorCode,
  ActionableErrorShape,
} from "../contracts/errors.contract.js";

export class ActionableError extends Error implements ActionableErrorShape {
  readonly code: ActionableErrorCode;
  readonly remediation: string;
  readonly rawMessage: string;
  override readonly cause?: string;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(shape: ActionableErrorShape) {
    const raw = shape.message.startsWith(`[${shape.code}] `)
      ? shape.message.slice(`[${shape.code}] `.length)
      : shape.message;

    super(`[${shape.code}] ${raw}`);
    this.name = "ActionableError";
    this.code = shape.code;
    this.rawMessage = raw;
    this.remediation = shape.remediation;

    if ("cause" in shape && shape.cause !== undefined) {
      this.cause = shape.cause;
    }
    if ("details" in shape && shape.details !== undefined) {
      this.details = shape.details;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON(): ActionableErrorShape {
    const res: {
      code: ActionableErrorCode;
      message: string;
      remediation: string;
      cause?: string;
      details?: Readonly<Record<string, unknown>>;
    } = {
      code: this.code,
      message: this.rawMessage,
      remediation: this.remediation,
    };
    if (this.cause !== undefined) {
      res.cause = this.cause;
    }
    if (this.details !== undefined) {
      res.details = this.details;
    }
    return res;
  }
}

export function createActionableError(shape: ActionableErrorShape): ActionableError {
  return new ActionableError(shape);
}
