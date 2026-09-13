# Contract Migration Receipt — ZB2.2-R7

- **Date**: 2026-09-09
- **Owner**: ZB2 (`packages/benchmark-kit/**` + `bridge/`)
- **Prior contract**: R6 (`35d062f`), Codex review `ZB2.2_R6_REVIEW_35d062f.md` → `CHANGES_REQUESTED`
- **Gate**: `G2_CORE_RUNTIME_INTEGRATED` remains **OPEN**. No Z5 copy.
- **Protocol**: Master Plan §11.6 item 3 (public contract change = migration with diff, consumers, validation, window).
- **Scope discipline (R7)**: minimal functional fixes making the real path work as planned. Ledger fsync hardening → explicit non-blocking backlog (review direction).

## 1. Production bugs fixed (all independently reproduced by Codex)

### 1.1 Double agent invocation (`bridge/shokunin_intercept_agent.py`)
R6's edit duplicated the `inner.run()` outcome block: clean returns executed
the inner agent TWICE. The method is rewritten with ONE invocation whose
outcome selects claim / timeout-outcome / error-outcome paths. Proven by the
R7 witness (`innerRunCalls === 1` on all five scenarios).

### 1.2 Missing `await` on workspace export (same file)
`self._export_workspace(...)` was called without `await`: `download_dir()`
never ran, no snapshot or export manifest existed. Now awaited; the witness
asserts live marker bytes inside the snapshot (fails on the old code with
`ShokuninBridgeError: zero workspace paths`).

### 1.3 Container/image identity conflation (same file)
`docker inspect <container>` field `Id` (the CONTAINER id) was recorded as
`imageId`, and the second inspect re-targeted the container. Now:
`containerId = inspect["Id"]`, `imageId = inspect["Image"]`, then
`docker inspect <imageId>` for RepoDigests. The witness asserts
`containerId !== imageId` and `imageId` equals the Image field.

### 1.4 Official A2 form (`src/adapters/harbor-adapter.ts`)
Real Harbor records `ShokuninGateBlocked` in `exception_info` AND increments
`n_errors = 1`, which R6 rejected before classification. `run()` accepts an
optional second parameter `{ allowExpectedGateBlocked }` (bridge sessions
only; direct runs stay strict) and then requires per errored trial:
GateBlocked-only exception + absent verifier + `gate-blocked.json` marker,
plus exact correspondence between observed exception trials and
`stats.n_errors`. AgentTimeoutError WITH a ran verifier stays tolerated
(Harbor verifies after timeouts). Unit doubles write the official shape
(`n_errors: 1` on BLOCK).

### 1.5 Closed launcher factory (`contracts` + `src/sessions/`)
`HarborBridgeSessionOptions.launcher: {command, prefixArgs}` (free-form) is
replaced by `launch: HarborLaunchSpec` (`uv-wheel` | `plain`). The session
BUILDS the spawn command: uv-wheel resolves uv, pins `--with <wheel>` and the
harbor module; plain carries no wheel trust ever. A counterfeit command with
the real wheel path in its arguments is structurally unrepresentable; the
plain/counterfeit record stays `cli-shape-only`. The bridge file itself is
hashed per session and recorded (ledger STARTED detail + job summary).

### 1.6 Single-flight gate + atomic verdict (session)
`serveGateRequests` tracks in-flight trials in a Map (no second evaluation
however many polls observe the pending request), awaits all pending
evaluations before return, and writes verdicts atomically (temp + rename).
Slow-gate (500 ms) test asserts exactly one evaluation.

### 1.7 Quarantine events (`src/integration/vertical-slice.ts`)
`buildCorruptTrialRecord` no longer synthesizes `native_completion_claim`
when the claim sidecar is absent (event list is conditional).

## 2. Executable witness (review items 6 + 8)

- `tests/fixtures/bridge-witness.py` runs the REAL
  `ShokuninInterceptAgent.run()` with a counting fake inner agent, a fake
  Harbor environment (records `download_dir`, materializes live bytes), and a
  stubbed `docker` subprocess (container vs image inspect payloads). Five
  node-driven scenarios: clean-pass, block, timeout, error, digest-mismatch —
  asserting single invocation, awaited export with live bytes, distinct IDs,
  BLOCK raise + marker, timeout/error outcome markers without claims, and pin
  enforcement. No test fabricates bridge sidecars for these paths.
- Bridge `--help-protocol` (stdlib-only, system python3) and class import +
  construction inside the REAL Harbor 0.1.2 uv env are tested.
- Host integration test now traverses `HarborBridgeSession` +
  `executeVerticalSlice` after the plain `run()` gate (digest bootstrapped
  from the just-built image; SKIP without daemon/uv/image).

## 3. Other contract deltas

- `HarborSessionJob.bridgeSha256` added (audited bridge bytes).
- `HarborBridgeSessionOptions.launch: HarborLaunchSpec` (replaces `launcher`).
- `HarborBridgeLauncher` type deleted.
- `file-lock.ts`: acquire loop covers mkdir ONLY; `fn()` errors propagate
  (bugfix found via failing test: duplicate-ID rejections decayed into
  5 s contention timeouts).
- `simulateBridgeRun/Trial` test doubles write the official A2 shape
  (`n_errors: 1`, `gate-blocked.json`) and support symlink injection.

## 4. Consumers
- `tests/harbor-adapter.test.ts`: bridge manifests unchanged in shape;
  launcher constructions migrated to `launch`; 8 new R7 tests (witness ×5,
  slow-gate, launcher identity ×2 paths, host slice).
- No other in-repo consumers.

## 5. Validation
- `pnpm --filter @shokunin/benchmark-kit typecheck` → exit 0.
- Core prebuilt, then benchmark-kit → **103 PASS, 1 SKIP (real host gate),
  0 FAIL** (104 tests).
- Bridge `--help-protocol`, uv-env import, bubblewrap wire-test PASS.
- Scope strictly ZB2; `git diff --check` clean; `/tmp` zero residuals.

## 6. Integration window
- Branch: `gemini/zb2-runtime-evidence`, commit `ZB2.2-R7`.
- Request: Codex Red Team counter-review (R7 mutations: double-run counter,
  awaited export, official A2 + n_errors, slow gate ×1, containerId≠imageId,
  fake launcher with real wheel path) before any `G2_CORE_RUNTIME_INTEGRATED`
  decision.
- Known non-blockers: root clean-checkout build order (Integration Owner);
  real host slice proof (SKIP — needs daemon; traverses new code when available).
- Backlog (non-blocking per review): ledger fsync/unique session-attempt IDs.
