# SOUL — Governance Core (ZB1)

## 1. Why this box exists

This box is the deterministic core of Shokunin governance.
Its sole responsibility is to evaluate explicit completion claims against locally declared verification checks, producing immutable, strongly typed, and actionable gate evaluation results.

In an agentic workflow, an agent tends to declare victory prematurely based on hallucinated confidence or partial execution.
The Completion Gate exists to replace declarative self-certification with **locally verifiable, deterministic evidence**.

## 2. Invariants that must never be broken

1. **The Public Contract is Sacred (Contract Survival Invariant)**:
   > The public contract is the system's promise to the rest of the architecture. Internal implementation may change freely when that promise is preserved. Never change a public contract as a side effect of an implementation change. If the requested behavior genuinely requires a contract change, stop treating the task as local maintenance and escalate it as a migration.

2. **Deterministic Isolation**:
   - The gate operates strictly within the workspace boundary provided.
   - It only executes explicitly declared checks (`DeclaredCheck`).
   - It has **zero awareness** and **zero access** to any external task oracle or benchmark verifier (no leakage of hidden test suites).
   - An empty check list (`declaredChecks: []`) is an invalid submission and must never pass.

3. **Actionable Outcomes & Fail-Closed Behavior**:
   - Every failure reason must be actionable: what failed, where, why, and what remediation is required.
   - Verdicts are strictly binary (`PASS` or `FAIL`), never speculative.
   - By default, unverified or malformed checks are treated as failures (`fail-closed`).

4. **Substitutability & Pure Dependency Inversion**:
   - The gate depends strictly on the `ICommandExecutor` abstraction, never on a concrete subprocess library or runtime environment.
   - Any compliant executor (mock, local process, containerized runner) can execute the checks without touching gate logic.

5. **Zero Implementation Leaks**:
   - Consumers only interact with `contracts/` and `schemas/`.
   - Internal functions, process spawning details, or formatting helpers remain private to `src/`.
