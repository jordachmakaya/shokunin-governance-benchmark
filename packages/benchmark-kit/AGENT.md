# AGENT — Benchmark Kit Zone Owner (ZB2)

## Operating Mode

ZB2 is sealed after **ZB2.2-R8.1 — G2_CORE_RUNTIME_INTEGRATED**.
`packages/benchmark-kit/**` is read-only until an explicit migration window is
opened by the Integration Owner.

## Responsibilities

1. Own all code, contracts, schemas, and tests under `packages/benchmark-kit/**`.
2. Stabilize the TypeScript contracts and Zod schemas for:
   - `BenchmarkTrial` and `CompletionClaim`
   - `SnapshotVerification` and external verification
   - `RuntimeCapability` matrix
   - `InfrastructureFailure` categorization
   - Harbor configuration and trial result parsing
   - NDJSON append-only persistence
3. Provide robust test fixtures corresponding to pinned Harbor trial artifacts.
4. Verify fail-closed behavior for absent, malformed, or out-of-range artifacts.
5. Strictly prevent development hook contamination in Harbor fixtures or workspaces.
