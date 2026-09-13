# Contract Migration Receipt — ZB2.2-R5

- **Date**: 2026-09-09
- **Owner**: ZB2 (`packages/benchmark-kit/**`)
- **Prior contract**: R4 (`f108940`), Codex review `ZB2.2_R4_REVIEW_f108940.md` → `CHANGES_REQUESTED`
- **Gate**: `G2_CORE_RUNTIME_INTEGRATED` remains **OPEN**. No Z5 copy.
- **Protocol**: Master Plan §11.6 item 3 (public contract change = migration with diff, consumers, validation, window).

## 1. Central architectural change

R4 executed TWO uncorrelated executions (`IAgentRunner.runAgent()` → claim/workspace A,
then `IHarborRunner.run()` → agent+verifier B) and presented them as one causal cycle.
R5 deletes the dual-runner architecture:

- `IAgentRunner` / `AgentExecution` REMOVED from `contracts/runtime-protocol.contract.ts`.
- New single abstraction `IPhasedHarborSession.executeSession()` — exactly ONE Harbor
  invocation per vertical slice; every claim, snapshot, gate verdict and verifier result
  derives from a native trial of that invocation.
- `HarborAdapter` (src, production implementation) implements `IPhasedHarborSession`.
  Mock executors in tests simulate CLI I/O bytes on the same code path only — they are
  never a second agent execution.
- `VerticalSliceOptions.harborRunner?` REMOVED, replaced by `harborSession?`
  (default: production `HarborAdapter`). `agentRunner`, `workspaceDirectory`,
  `snapshotDirectory`, `nativeClaim`, `workspaceHash`, `containerDigest`,
  `promptSnapshotHash` are gone (R4 already removed most; R5 removes the rest).

## 2. Contract diff

### 2.1 `contracts/trial.contract.ts` + `schemas/trial.schema.ts`
- `BenchmarkTrialExecution` gains `runtimeRunId` (native Harbor trial UUID) and
  `workspaceId` (native Harbor trial name) — persisted correlation, not just checked.
- New `ArtifactProvenanceRef` / `BenchmarkTrialProvenance` (`prompt`, `container`,
  `workspaceSnapshot` with kind/originPath/byteLength/sha256). The R4 decorative export
  is now a REQUIRED persisted field.
- New `BenchmarkTrialHarborCorrelation` (`jobId`, `trialId`, `trialName`, `resultPath`,
  `resultHash`); `BenchmarkTrial.harbor` is null only for infrastructure-failure records.
- New `BenchmarkTrial.distribution: "manifest-pinned-verified" | "cli-shape-only"` —
  every record self-declares its distribution authentication level; shape-only records
  can never support a G2 claim.

### 2.2 `contracts/runtime-protocol.contract.ts`
- `RuntimePhaseEvent` gains `verifier_skipped` (untrusted trial, no verifier record)
  and `trial_blocked` (A2 gate FAIL, no verifier record). `verifier_finished` is
  emitted EXACTLY when a verifier is persisted — never fictitiously.
- New `HarborSessionRequest` (manifest-derived authority incl. optional
  `expectedHarborBinarySha256`), `HarborSessionTrialNative` (all natively derived
  per-trial fields), `HarborSessionJob` (sessionRunId, jobResultHash,
  effective/manifest digests, distribution attestation, trials),
  `IPhasedHarborSession`, `HarborDistributionAttestation` (+ identity union).

### 2.3 `contracts/harbor.contract.ts`
- `HarborJobRequestBase` gains optional `expectedHarborBinarySha256` — the pin travels
  with the EXPERIMENT manifest (lab authority). Executor-chosen adapter/preflight hash
  options are DELETED (R4 self-attestation flaw: a fake supplied its own hash).

### 2.4 `src/adapters/harbor-adapter.ts`
- `HarborAdapterOptions.expectedHarborBinarySha256` and
  `PreflightOptions.expectedHarborBinarySha256` DELETED.
- `PreflightStatus.harborIdentity` is now `"manifest-pinned-verified" | "cli-shape-only"`;
  public preflight never verifies pins (always `cli-shape-only` + optional binary hash).
- `run()` ALWAYS executes the mandatory preflight gate first (unbypassable), resolves
  the launcher to an absolute path with the EXECUTION env PATH (R4 used process PATH),
  verifies the manifest pin, and re-hashes before exec (TOCTOU guard).
- Genuine-CLI shape recalibrated to the OFFICIAL 0.1.2 output (verified live via uv):
  `Commands` WITHOUT colon (R4's `Commands:` regex rejected the real CLI); version via
  importlib metadata through the same launcher prefix (the real CLI has no `--version`
  and prints no version in `--help`); pinned `0.1.2` still enforced when obtainable.
- Trial URI: ONLY canonical `file://`, URL-decoded, `realpath`-resolved, confined
  (`custom://`, bare paths, dangling targets rejected).
- Task binding exact (no fuzzy basename); inner `config.job_id` + `config.task.path`
  mandatory + exact (unchanged from R4, kept).
- New `executeSession()`: single invocation → native per-trial derivation (agent phase
  timing → claim timestamp; agent/model/task/URI/checksum binding data; rewards, tokens,
  hashes) + effective digest resolution + manifest comparison.
- New `extractManifestImageDigest()` helper.

### 2.5 New modules (all under `src/adapters/`, lab-owned)
- `harbor-distribution-allowlist.ts`: pinned version `0.1.2`, official wheel SHA-256
  (`1478347e…457b7a5`, verified offline), identity taxonomy. A fake cannot list itself.
- `docker-digest-resolver.ts`: `resolveEffectiveDigest()` (`docker/podman image inspect`
  → RepoDigests, fail-closed), `resolveExecutableAbs()` (env-PATH-aware),
  `sha256OfExecutable()`.
- `trial-uri.ts`: `assertTrialUriConfined()` shared by adapter and slice.

### 2.6 `src/integration/vertical-slice.ts`
- Claims derive from NATIVE trial timing (`agent_execution.finished_at` → `finished_at`);
  `declaredDone:true` by construction (no caller claim exists to lie).
- Snapshots seal NATIVE trial directories; `assertNoSpecialFiles()` rejects symlinks,
  sockets, FIFOs, devices pre- and post-copy (SYMLINK_ESCAPE fix). Unsealable trials
  become recorded corrupt trials (quarantine), never silent acceptance.
- Options→manifest binding (agent name, model_name) pre-flight; trial→options binding
  (checksum, task, agent, model) per trial; session-manifest digest cross-check.
- Per-trial gate on per-trial snapshots; A2 BLOCK → `trial_blocked`, verifier null,
  correlation KEPT; corrupt trials → `verifier_skipped` + `VERIFIER_FAILURE` record.
- Job-level failures (timeout/exception/zero-trials) persist exactly one failure record
  (sealed `failure.json` evidence, `claims: []`, `harbor: null` unless native IDs exist)
  and then rethrow — every attempt is recorded.
- Reproducibility digest = RUNTIME-RESOLVED effective digest; provenance refs populated
  for prompt/container/snapshot on every record.
- Result: `trials[]`, per-trial `eventLogs[]` + `snapshotRefs[]` + `gateResults[]`
  (singular aliases kept for the primary trial). `jobResult` removed (session exposes
  `sessionRunId` per record instead).

### 2.7 `src/persistence/ndjson-store.ts`
- `NDJsonStoreOptions<T>`: optional `idOf` (exactly-once: intra-batch + on-disk
  duplicate rejection) and `lockTimeoutMs`.
- Interprocess `.lock` dir with holder stamp + staleness recovery; single
  `writeSync` + `fsyncSync` per batch; torn-tail detection on read
  (`assertNoPartialTail`, fail-closed) + `repairPartialTail()` (truncate + byte count).

## 3. Consumers
- `tests/harbor-adapter.test.ts`: 11 slice calls migrated (no agentRunner/containerDigest;
  `harborSession`; oracle/oracle-v1 binding; confined URIs; manifest model_name; probe
  router answering `--help`/`run --help`/`docker info|inspect`); A2/EMPTY/CAUSAL/WRITABLE/
  ARTIFACT/PARTIAL/UNBOUND/OFFICIAL/LEAK rewritten to single-run semantics; 9 new R5
  mutation tests (SINGLE_INVOCATION, SYMLINK quarantine, UNBOUND_IDENTITIES adapter +
  slice multi-agent corrupt record, SELF_ATTESTED manifest pin, DRIFT, PARTIAL+custom URI,
  FAILED_ATTEMPT timeout+record, STORE exactly-once/partial/repair).
- `tests/contracts.test.ts`: trial fixtures extended with provenance/harbor/distribution/ids.
- `tests/ndjson-store.test.ts`: unchanged API (options optional), passing.
- Future ZB3/ZB5/ZB6 must build `VerticalSliceOptions` without agentRunner and consume
  `trials[]`/`eventLogs[]`; `distribution: "cli-shape-only"` records are pilot-grade only.

## 4. Validation
- `pnpm --filter @shokunin/benchmark-kit typecheck` → exit 0.
- Core prebuilt, then `pnpm --filter @shokunin/benchmark-kit test` →
  **90 PASS, 1 SKIP (real Harbor/Docker host gate), 0 FAIL**.
- Real-CLI calibration: official wheel `--help`/`run --help`/importlib version executed
  live via uv; the BUBBLEWRAP wire-test (real Harbor 0.1.2 + simulated daemon) PASSES
  through the mandatory preflight gate.
- Scope: `git status` strictly under `packages/benchmark-kit/**`; `git diff --check` clean;
  `/tmp` zero `harbor-snapshot-*`/`harbor-failure-*` residuals post-suite.

## 5. Integration window
- Branch: `gemini/zb2-runtime-evidence`, commit `ZB2.2-R5`.
- Request: Codex Red Team counter-review (independent mutations + clean-clone run) before
  any `G2_CORE_RUNTIME_INTEGRATED` decision. R5 criteria mapping is in HANDOFF.md.
- Known non-blockers owned elsewhere: root clean-checkout build order (`@shokunin/core`
  dist before typecheck) and the real Harbor+DOCKER host proof (still SKIP here) —
  G2 stays OPEN until the host proof executes.
