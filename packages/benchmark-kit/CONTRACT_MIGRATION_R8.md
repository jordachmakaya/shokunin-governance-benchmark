# Contract Migration Receipt — ZB2.2-R8

- **Date**: 2026-09-09
- **Owner**: ZB2 (`packages/benchmark-kit/**` + `bridge/`)
- **Prior contract**: R7 (`6ec0b62`), Codex review `ZB2.2_R7_REVIEW_6ec0b62.md` → `CHANGES_REQUESTED`
- **Gate**: `G2_CORE_RUNTIME_INTEGRATED` remains **OPEN**. No Z5 copy.
- **Protocol**: Master Plan §11.6 item 3 (public contract change = migration with diff, consumers, validation, window).
- **Scope discipline (R8)**: only the seven mandated fixes; no additional hardening beyond the review's exit criteria.

## 1. Production bugs fixed (all independently reproduced by Codex)

### 1.1 Strict sidecar validation (`src/adapters/sidecars.ts`, new)
R7 accepted any parseable JSON as proof: `declaredDone:false` became a valid
claim, unread markers counted as prevention. Every sidecar now has an exact
Zod contract: claim requires literal `declaredDone:true` + ISO timestamp +
exact `trialName`; outcome requires literal `false` + timeout/error enum;
gate request/verdict/marker, container identity and export manifest are all
schema-validated. Claim and agent-outcome are mutually exclusive by
construction (both present → neither trusted → quarantine).
Gate requests additionally require a governed arm and an exact realpath
binding to the native trial's `workspace-snapshot`; foreign snapshots never
reach the completion gate.

### 1.2 Exact A2 prevention proof (adapter + session via shared helper)
`exception_type.includes(...)` replaced by `=== "ShokuninGateBlocked"`;
`gate-blocked.json` is parsed (not presence-checked) with exact trialName and
internal `BLOCK`; coherence with a strictly parsed `gate-verdict.json`
(`BLOCK`) is required. `isProvenGateBlock()` in `sidecars.ts` is the single
implementation used by both `HarborAdapter.run` and the session, so the two
gates cannot drift.

### 1.3 Executed authority (`src/sessions/launch-authority.ts`, new, pure)
R7 marked `wheel-verified` from the `kind` discriminant: arbitrary `uvPath`
plus arbitrary bridge bytes inherited full trust. Now a pure function of
verified inputs: wheel bytes vs official constant (throw on mismatch), bridge
bytes vs versioned lab-owned allowlist (throw on mismatch), uv resolvable AND
literally named `uv`/`uv.exe` (else cli-shape-only), plain always
cli-shape-only. `wheel-verified` therefore means resolved uv + official wheel
+ allowlisted bridge. Mocks can never produce it; unit tests exercise the
function directly with real files.
An explicit `uvPath` remains executable with the pinned wheel arguments for
compatibility, but is always downgraded to `cli-shape-only` and cannot support
publication-grade claims.

### 1.4 Versioned bridge allowlist (`src/adapters/bridge-allowlist.ts`, new)
`BRIDGE_ALLOWLIST = { "1.0.0-r8": "<sha256 of exact bridge bytes>" }` plus
`lookupBridgeVersion()`. Recording stopped being the check: unknown bridge
bytes throw fail-closed. Entries are added explicitly per bridge release.

### 1.5 A0 event honesty (`src/integration/vertical-slice.ts`)
`gate_evaluated` is pushed only when a gate was actually requested and
observed. A0 logs contain zero gate events.

### 1.6 Host witness without global harbor (tests)
Readiness resolves through `resolveLaunchAuthority` (uv-wheel) plus a real
`docker info` probe; the global-`harbor` preflight and the `spawnSync("uv")`
probe are gone. Attestation (incl. `bridgeVersion`) flows into the session.

### 1.7 Version + handoff accuracy
`BRIDGE_VERSION = "1.0.0-r8"` in the bridge; uv-env import test also asserts
the version string. Receipt/memory/handoff regenerated from the actual diff.

## 2. Contract deltas

- `HarborDistributionAttestation` gains `bridgeVersion: string | null`.
- `HarborSessionTrialNative` semantics tightened (no shape change):
  `claimPresent` now means strict-valid claim; `gateBlocked` now means strict
  proof. `agentOutcome.reason` is trusted only from a strictly valid outcome
  file coexisting with no claim file.
- `HarborBridgeSessionOptions` unchanged in shape (`launch` spec already
  closed in R7); its *interpretation* changed per §1.3 (uv must resolve).
- No schema-file changes (sidecar schemas live in `src/`, mirroring the
  existing `schemas/` Zod style with `z.iso.datetime()`).

## 3. Consumers
- `tests/harbor-adapter.test.ts`: R8 launcher test now expects
  cli-shape-only for arbitrary uv; new authority unit tests (6 cases);
  three Codex mutations as named tests; A0/timeout expectations drop
  `gate_evaluated`; bridge-witness fixture untouched (real bridge behavior
  unchanged — only the version string).
- Future ZB3/ZB5/ZB6: consume `distribution.bridgeVersion`; treat any
  non-`wheel-verified` record as pilot-grade.

## 4. Validation
- `pnpm --filter @shokunin/benchmark-kit typecheck` → exit 0.
- Core prebuilt, then benchmark-kit → **110 PASS, 1 SKIP (real host gate),
  0 FAIL** (111 tests).
- Root `pnpm test` after the declared Core build → exit 0.
- Bridge `--help-protocol`, 5/5 witness scenarios, uv-env import (name +
  version), bubblewrap wire-test PASS.
- Bridge allowlist entry recomputed programmatically from final bytes
  (never hand-transcribed).
- Scope strictly ZB2; `git diff --check` clean; generated bridge
  `__pycache__` removed before commit.

## 5. Integration window
- Branch: `gemini/zb2-runtime-evidence`, commit `ZB2.2-R8`.
- Delivery attribution: MIXED — Muse Spark implementation completed by Codex
  under explicit user authorization after Muse's token cutoff.
- Request: Codex Red Team counter-review (R8 exit criteria: three mutations
  rejected; R7 corrections still passing; A0 gateless; clean suite after
  declared integration build; host witness via official launcher or explicit
  sole external blocker) before any `G2_CORE_RUNTIME_INTEGRATED` decision.
- Known non-blockers: root clean-checkout build order (Integration Owner);
  real host slice proof (SKIP — needs daemon; ledger fsync hardening stays
  accepted backlog per review direction).
