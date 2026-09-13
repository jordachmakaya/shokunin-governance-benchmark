# Contract Migration Receipt — ZB2.2-R4

- **Date**: 2026-09-09
- **Owner**: ZB2 (`packages/benchmark-kit/**`)
- **Prior contract**: R3 (`e410a47`), Codex review `ZB2.2_R3_REVIEW_e410a47.md` → `CHANGES_REQUESTED`
- **Gate**: `G2_CORE_RUNTIME_INTEGRATED` remains **OPEN**. No Z5 copy.
- **Protocol**: Master Plan §11.6 item 3 (public contract change = migration with diff, consumers, validation, window).

## 1. Contract diff

### 1.1 New public contract: `contracts/runtime-protocol.contract.ts`
- `RuntimeClaimEvent`: `declaredDone: true` (literal), `timestamp`, `runtimeRunId`, `workspaceId`, `promptTokensAtClaim?`.
- `IAgentRunner.runAgent(): Promise<AgentExecution>` — the ONLY claim source.
- `RuntimeEventLog`: `agent_started → native_completion_claim → snapshot_sealed → gate_evaluated → verifier_finished` with monotonic enforcement.
- `SealedSnapshotRef`: content-addressed (`snapshotId`, `storePath`, `fileCount`, `totalBytes`, `sealedAt`).
- Re-exported from `src/index.ts`.

### 1.2 `src/integration/vertical-slice.ts` — breaking options change
Removed (were declarative / synthetic):
- `nativeClaim?: { timestamp?, declaredDone? }` — replaced by required `agentRunner: IAgentRunner`.
- `workspaceDirectory?`, `snapshotDirectory?`, `workspaceHash?` — workspace comes from `agentRunner.runAgent()`; snapshot is sealed to `<ndjsonDir>/snapshots/<sha256>/` read-only.
- `agent.promptSnapshotHash?` — bare hashes without bytes rejected.
- Optional provenance fallbacks: `exp-vertical-slice`, `campaign-1`, `H1_COMPLIANCE_GATE`, `0.1.2`, `node`, `process.version` — all removed.

Required (fail-closed `CONFIG_INVALID` otherwise):
- `experimentId`, `campaignId`, `hypothesisId`, `repetitionIndex`, `runtimeId`, `runtimeVersion` (all non-empty / non-negative int).
- `task.benchmarkVersion` (non-empty; no longer hardcoded).
- `containerDigest`, when provided, MUST equal the manifest-declared OCI digest (`environment.image`); otherwise the manifest digest is used. Arbitrary digests rejected (`UNBOUND_PROVENANCE`).
- `agent.promptPath` (existing file) OR non-empty `agent.promptContent`; hash derived mechanically from bytes.

Result change (`VerticalSliceResult`):
- Added `trials: readonly BenchmarkTrial[]` — EVERY Harbor trial persisted (N→N, atomic `appendBatch`). `trial` kept as primary (first) for compatibility; single-trial runs keep `options.trialId`, multi-trial runs use `${trialId}__${trialName}`.
- Added `eventLog: RuntimeEventLog` and `snapshotRef: SealedSnapshotRef`; `snapshotDirectory` kept as alias to `snapshotRef.storePath`.
- Metrics: `falseCompletionIntercepted` is now always `null` (snapshot-verifier parity unqualified); `falseCompletionInitial` stays `null`; `falseCompletionTerminal` is `null` when verifier is null, else `!passed`.

### 1.3 `src/adapters/harbor-adapter.ts`
- `HarborAdapterOptions.expectedHarborBinarySha256?` and `PreflightOptions.expectedHarborBinarySha256?` added.
- `PreflightStatus` adds `harborIdentity: "pinned-hash-verified" | "text-only-unverified"` and `harborBinarySha256?`. Text-only `--help` probing is explicitly NOT distribution authentication (R3 P0 `OFFICIAL_LOOKING_FAKE`); production manifests must pin the binary hash.
- `run()` strictness: inner `result.config.job_id` MANDATORY and correlated to parent job id; inner `config.task.path` MANDATORY and exact match against manifest tasks (fuzzy basename removed); `task_id.path`/`task_name` exact match; `file://` trial URIs resolved and confined under the expected job directory (foreign `file://` rejected); `https?/ftp/sftp` rejected as before.

## 2. Consumers
- `tests/harbor-adapter.test.ts` updated (11 vertical-slice calls migrated to `agentRunner` + mandatory provenance + confined `file://` URIs + manifest-bound digests; 7 new R4 mutation tests).
- No other workspace package imports the changed symbols yet (ZB3/ZB5/ZB6 do not exist). `contracts.test.ts`, `harbor-schema.test.ts`, `ndjson-store.test.ts`, `isolation.test.ts` unaffected and passing.
- Future consumers (ZB3 evals, ZB5 H1 definitions, ZB6 CLI) must construct `VerticalSliceOptions` with the new required fields and consume `trials[]` (not just `trial`).

## 3. Validation
- `pnpm --filter @shokunin/benchmark-kit typecheck` → exit 0.
- `pnpm --filter @shokunin/core build` then `pnpm --filter @shokunin/benchmark-kit test` → **86 PASS, 1 SKIP (real Harbor/Docker host gate), 0 FAIL**.
- New R4 mutations: `DECLARED_DONE_FALSE`, `WRITABLE_SNAPSHOT`, `TWO_TRIALS_ONE_RECORD`, `UNBOUND_PROVENANCE`, `OFFICIAL_LOOKING_FAKE`, `PARTIAL_CROSS_LINKS` (task/job_id/URI), `SNAPSHOT_LEAK_ON_ERROR`, plus causal `eventLog` order assertion.
- Scope: `git status` shows modifications strictly under `packages/benchmark-kit/**`.

## 4. Integration window
- Branch: `gemini/zb2-runtime-evidence`, commit `ZB2.2-R4`.
- Request: Codex Red Team counter-review (mutations + clean-clone run) before any `G2_CORE_RUNTIME_INTEGRATED` decision.
- Known non-blockers owned elsewhere: root `pnpm test` from a clean checkout still requires a prior `@shokunin/core` build (Integration Owner scope, outside ZB2); real Harbor CLI + Docker/Podman host test remains SKIP (no daemon on this host) — G2 stays OPEN until that host proof executes.
