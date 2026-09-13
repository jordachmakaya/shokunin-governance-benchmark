# Contract Migration Receipt — ZB2.2-R6

- **Date**: 2026-09-09
- **Owner**: ZB2 (`packages/benchmark-kit/**`)
- **Prior contract**: R5 (`1a819b3`), Codex review `ZB2.2_R5_REVIEW_1a819b3.md` → `CHANGES_REQUESTED`
- **Gate**: `G2_CORE_RUNTIME_INTEGRATED` remains **OPEN**. No Z5 copy.
- **Protocol**: Master Plan §11.6 item 3 (public contract change = migration with diff, consumers, validation, window).

## 1. Central architectural change

R5 ran one `harbor run` but reconstructed the causal cycle post-hoc (agent →
verifier → session return → snapshot → gate): A2 deleted an already-observed
verifier, the snapshot covered Harbor logs (not the container), and
`finished_at` was coerced into `declaredDone:true`.

R6 moves interception INSIDE the trial via the lab-owned bridge agent
(`bridge/shokunin_intercept_agent.py`, loaded by Harbor 0.1.2 through the
manifest agent `import_path`). The bridge wraps the experiment agent and,
inside the agent phase with the container alive and BEFORE Harbor starts the
verifier: observes the native outcome, writes `claim.json` (clean return only)
or `agent-outcome.json` (timeout/error, unclaimed), resolves the LIVE
container identity (`docker inspect`), enforces the lab digest pin, exports
the container workspace, and handshakes the gate. On A2+BLOCK it raises
`ShokuninGateBlocked`, so `TrialResult.verifier` stays `None` — the
prevention proof. The TypeScript `HarborBridgeSession` spawns the run and
serves live verdicts concurrently; mocks simulate bridge sidecar bytes on the
same protocol, never production helpers.

## 2. Contract diff

### 2.1 `contracts/runtime-protocol.contract.ts`
- `HarborSessionRequest`: `{jobConfigPath, jobsRoot, expectedJobName, timeoutMs,
  successCriterion, expectedTaskChecksum?, taskDirectory?, arm, gateDecider?,
  ledgerPath, expectedContainerDigest (REQUIRED pin)}`. `GateDecider` callback
  type added. `verdictTimeoutMs` and `HarborSessionAuthority` removed.
- `HarborSessionTrialNative`: sidecar-derived natives — `claimPresent`,
  `claimTimestamp|null`, `agentOutcome|null`, `verifierPresent`, `gateBlocked`,
  `snapshotDir`, `exportedPaths`, `gateRequested`, `gateVerdictObserved`,
  `gateSnapshotHash`, `gateId`, `gateFailureReasons`, `containerId`,
  `containerDigestEffective`, `containerImageRef`, `containerRepoDigests`.
- `HarborSessionJob`: `{sessionRunId, jobDirectory, jobResultHash,
  effectiveContainerDigest, distribution, trials}` (manifest digest dropped:
  the pin lives in the request/manifest kwargs, the fact in the container).
- `HarborDistributionAttestation`: `{identity, harborVersion: string|null,
  versionSource, wheelSha256}` (no more hardcoded `0.1.2`/`importlib`;
  the bridge reports the REAL loaded version).
- `HarborDistributionIdentity`: `"wheel-verified" | "cli-shape-only"`
  (renamed; `manifest-pinned-verified` deleted with the self-attestation path).
- `HarborBridgeSessionOptions`: `{executor?, launcher, bridgeScriptPath, wheelPath, env?}`.
- `NativeAgentOutcome` added. `ArtifactProvenanceRef` re-export unchanged.

### 2.2 `contracts/trial.contract.ts` + `schemas/trial.schema.ts`
- `BenchmarkTrialHarborCorrelation` gains `containerId` and `containerDigest`
  (effective, live-inspected).
- `provenance.container` is now byte-true: `{kind:"container-manifest",
  originPath:<manifest>, byteLength:<manifest bytes>, sha256:<manifest sha>}`.
  The effective digest lives in `reproducibility.containerDigest` and
  `harbor.containerDigest` (fixes R5 incoherence).
- `distribution` renamed to `"wheel-verified" | "cli-shape-only"`.

### 2.3 `contracts/harbor.contract.ts`
- `HarborJobRequestBase.expectedHarborBinarySha256` DELETED (review explicit:
  a request must never supply the hash that validates it).

### 2.4 New `contracts/ledger.contract.ts` + `schemas/ledger.schema.ts`
- `SessionLedgerEvent`: job `STARTED` (pre-spawn) / `SESSION_COMPLETED` /
  `SESSION_FAILED` + per-trial `TRIAL_COMPLETED|BLOCKED|QUARANTINED|FAILED`.

### 2.5 `src/adapters/harbor-adapter.ts`
- `HarborAdapterOptions.expectedHarborBinarySha256` and
  `PreflightOptions.expectedHarborBinarySha256` DELETED.
- `PreflightStatus.harborIdentity`: `"manifest-pinned-verified" |
  "cli-shape-only"` (kept for the plain path; sessions attest `wheel-verified`).
- Genuine-CLI shape recalibrated to official output (`Commands` without colon;
  version via help text or importlib probe, unresolved tolerated).
- `run()` keeps mandatory preflight + TOCTOU re-hash (observed hash only).
- R5 `executeSession()` + `extractManifestImageDigest()` DELETED (replaced by
  the bridge session; `environment.image` is not a Harbor 0.1.2 field).
- Trial agent checks are bridge-aware (config `import_path` + kwargs inner
  agent); trial URIs require EXACT realpath equality (`assertTrialUriExact`).

### 2.6 New `src/adapters/trial-uri.ts`
- `assertTrialUriConfined` replaced by `assertTrialUriExact`: `file://` only,
  decoded, `realpath`-resolved, STRICTLY equal to the discovered trial dir
  (homonym suffix attack closed).

### 2.7 New `src/sessions/harbor-bridge-session.ts`
- Wheel bytes hashed vs `OFFICIAL_HARBOR_WHEEL_SHA256` BEFORE any work;
  `HarborAdapter.run()` for the single invocation (preflight/freshness/
  validation reused); live gate service with pre-gate snapshot hash and
  read-only gate window; fail-closed BLOCK verdicts; post-join unanswered-
  request sweep; STARTED/COMPLETED/FAILED ledger; sidecar-derived natives.

### 2.8 `src/integration/vertical-slice.ts`
- Claims ONLY from `claim.json` (clean native return); timeouts/errors carry
  `agent-outcome.json` and NO claim (`finished_at` never coerced).
- Snapshots seal the bridge-exported container workspace; seal vs gate-time
  hash compared (TOCTOU guard).
- Gate transcript observed (single evaluation); A2+BLOCK requires verifier
  absence + GateBlocked exception (else quarantine); A1 observed-BLOCK keeps
  the verifier (R5 deletion fixed); timeout trials keep a ran verifier with
  `claims: []` and `timeout` stop.
- Manifest↔options bridge binding (name/import_path/model/inner/arm/digest);
  trial↔options binding per trial; digest drift quarantines per trial.
- INCREMENTAL persistence (one locked append + ledger terminal per trial):
  late exceptions lose nothing built.
- Failure/quarantine records with sealed `failure.json` evidence.

### 2.9 `src/persistence/` — `file-lock.ts` (new), `session-ledger.ts` (new),
  `ndjson-store.ts` (reworked)
- `withFileLock`: acquire loop covers mkdir ONLY; fn() errors propagate
  (R6 bugfix: nested fn errors previously decayed into contention timeouts).
- `appendBatch`: read + uniqueness + write + fsync UNDER ONE lock; writeAll
  loop; torn-tail pre-check inside the lock.
- `SessionLedger`: locked append + validated read.

### 2.10 `bridge/shokunin_intercept_agent.py` (new, lab-owned, auditable)
- Wrapper agent (`import_path`), transparent inner identity, native outcome
  handling (claim vs timeout vs error with Harbor semantics preserved), live
  `docker inspect` identity, digest pin enforcement, container workspace
  export with manifest, A1/A2 gate handshake with poll timeout, A2+BLOCK
  raise (verifier never starts), `--help-protocol` stdlib-only entry.

## 3. Consumers
- `tests/harbor-adapter.test.ts`: bridge manifests (no `environment.image`);
  `simulateBridgeRun/Trial` protocol doubles (topology + sidecars + REAL
  handshake against session code); 14 new/rewritten R6 tests (ledger,
  timeout-keeps-verifier, wheel allowlist + counterfeit, uv-env bridge import,
  multiprocess duplicate race, nested-URI, drift quarantine, mirroring bug,
  read-only gate window).
- `tests/contracts.test.ts`, `tests/harbor-schema.test.ts`: extended fields,
  nullable `verifier_result`.
- `tests/fixtures/store-concurrency-child.mjs`: new race probe.
- Future ZB3/ZB5/ZB6: build bridge manifests, pin digests, consume `trials[]`/
  `eventLogs[]` + ledger; `cli-shape-only` records are pilot-grade only.

## 4. Validation
- `pnpm --filter @shokunin/benchmark-kit typecheck` → exit 0.
- Core prebuilt, then benchmark-kit → **96 PASS, 1 SKIP (real Harbor/Docker
  host gate), 0 FAIL**.
- Bridge module `--help-protocol` on system python3 (no Harbor needed) PASS;
  bridge class import + construction inside the REAL Harbor 0.1.2 uv env PASS;
  bubblewrap wire-test (real Harbor, `run()` path) PASS.
- Scope strictly `packages/benchmark-kit/**` + `bridge/` (inside ZB2);
  `git diff --check` clean; `/tmp` zero residuals.

## 5. Integration window
- Branch: `gemini/zb2-runtime-evidence`, commit `ZB2.2-R6`.
- Request: Codex Red Team counter-review (R6 mutations: post-hoc causality,
  self-attested counterfeit, concurrent duplicate, homonym URI) before any
  `G2_CORE_RUNTIME_INTEGRATED` decision.
- Known non-blockers owned elsewhere: root clean-checkout build order and the
  real Harbor+Docker host slice proof (still SKIP — needs a daemon and a
  digest bootstrap for the oracle image).
