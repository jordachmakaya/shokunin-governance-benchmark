export type GateVerdict = "PASS" | "FAIL";

export interface DeclaredCheck {
  readonly id: string;
  readonly description: string;
  readonly required: boolean;
}

export interface GateEvaluationInput {
  readonly gateId: string;
  readonly declaredChecks: readonly DeclaredCheck[];
  readonly evidenceRoot: string;
}

export interface GateCheckResult {
  readonly id: string;
  readonly verdict: GateVerdict;
  readonly evidence: readonly string[];
  readonly message: string;
}

export interface GateEvaluationResult {
  readonly gateId: string;
  readonly verdict: GateVerdict;
  readonly evaluatedAt: string;
  readonly checks: readonly GateCheckResult[];
}

export interface ICompletionGate {
  evaluate(input: GateEvaluationInput): Promise<GateEvaluationResult>;
}
