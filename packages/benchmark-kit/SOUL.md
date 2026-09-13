# SOUL — Harbor Runtime & Evidence Pipeline (ZB2)

## 1. Why this box exists

This box is the evaluation and execution runtime adapter for the Shokunin benchmark apparatus.
Its responsibility is to orchestrate task execution through containerized Harbor environments, capture reproducible subject snapshots, classify execution outcomes and infrastructure failures, and persist validated evidence records in append-only NDJSON streams.

In scientific benchmarking, measurement contamination is the ultimate threat to validity.
The Benchmark Kit guarantees that:
- External task verifiers remain completely inaccessible to the agent during execution.
- Trial records are immutable, strongly typed, and cryptographically linked to their container and prompt digests.
- Infrastructure and harness crashes are cleanly distinguished from agent failures.

## 2. Invariants that must never be broken

1. **The Public Contract is Sacred**:
   Public contracts (`contracts/` and `schemas/`) are promises. Internal adapters and normalizers may evolve, but the public output schema remains stable.

2. **Strict Measurement Isolation**:
   - Zero development hooks or governance scripts are ever copied into Harbor trial containers.
   - The Harbor task verifier is an external oracle executed post-trial; agents under test have zero direct access to it.

3. **Fail-Closed Evidence Parsing**:
   - Missing job, trial, reward, or digest artifacts result in deterministic failure classification.
   - Corrupted or malformed records in NDJSON stores trigger actionable errors immediately without data corruption.

4. **Pure Dependency Boundary**:
   - `packages/benchmark-kit` depends ONLY on the public contracts/schemas of `@shokunin/core`.
   - Never import from `packages/core/src/**`.

5. **Exogenous Failure Accountability**:
   - Transient infrastructure failures (container crashes, harness timeouts) are classified and tagged with `retryable: true` or `false` according to methodological rules.
