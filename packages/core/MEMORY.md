# MEMORY — Governance Core State (ZB1)

## Public Contract Surface
- `contracts/gate.contract.ts`: Declares `GateVerdict`, `DeclaredCheck`, `GateEvaluationInput`, `GateCheckResult`, `GateEvaluationResult`, and `ICompletionGate`.
- `contracts/executor.contract.ts`: Declares `CommandRequest`, `CommandExecutionResult`, and `ICommandExecutor`.
- `contracts/errors.contract.ts`: Declares `ActionableErrorCode` and `ActionableErrorShape`.
- `schemas/gate-result.schema.ts`: Zod schema validating gate result outputs.

## Implementation Details
- `src/completion-gate.ts`: Core implementation of `ICompletionGate` using an injected `ICommandExecutor`. Includes robust quote-aware command tokenizer (`tokenizeCommandLine`) and fail-closed validation. Rejects empty `declaredChecks: []`.
- `src/local-command-executor.ts`: Node.js child_process wrapper implementing `ICommandExecutor` with strict timeouts, process tree group killing (`process.kill(-pid)`), pipe drain timeout, and 2MB output buffer cap.
- `src/errors.ts`: Actionable error builders conforming to `ActionableErrorShape`. Idempotent serialization (`rawMessage`).
- `src/index.ts`: Public library facade exporting public types, factories, and schema validators.

## Package Dependencies & Build
- `package.json`: Declares `@shokunin/core` with exports mapping, depends on `zod: 4.1.5`.
- `dist/`: Compiled ESM JavaScript artefacts produced by `npm run build`.

## Tests & Verification
- `tests/completion-gate.test.ts`: Unit tests using fake command executors covering PASS, FAIL, TIMEOUT, quote tokenization, empty checks rejection, buffer capping, and Actionable Error flows.
