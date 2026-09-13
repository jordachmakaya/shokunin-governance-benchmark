# Handoff — ZB2.2-R8.1: Host-Proven Podman Compatibility & Evidence Hygiene

## Milestone Status: ACCEPTED AND SEALED (ZB2.2-R8.1)
- **Milestone**: `ZB2.2-R8.1 — Host-Proven Podman Compatibility & Evidence Hygiene`
- **Verdict**: `PASS`, independently reviewed by actor `buffy` using Mimo-v2.5 and accepted by the Integration Owner.
- **Gate Status**: `G2_CORE_RUNTIME_INTEGRATED` is **SEALED PASS**. ZB2 is read-only.
- **Sealed Zone**: `packages/benchmark-kit/**` + `bridge/` (ZB2)
- **Next gate**: `G2A_Z5_SOURCE_SELECTION_FROZEN`; no ZB5 copy before it.
- **Lineage**: Gemini → Claude Sonnet (R3) → Muse Spark (R4–R7) → MIXED Muse Spark/Codex (R8; user-authorized completion after token cutoff)
- **R8.1 delivery attribution**: Codex (exceptional user-authorized completion)

---

## R8.1 host closure

The R8 review reported `HOST_WITNESS_NOT_RUN`. Running the same boundary on a
real Podman host exposed defects that mocks had hidden. R8.1 corrects only
those observed defects:

1. Harbor 0.1.2 invokes Docker Compose features not implemented by
   `podman-compose` (`compose cp`, interactive `compose exec`) and assumes
   Docker-style container names. The versioned executable
   `bridge/podman-compat/docker` translates only this required surface to
   Podman and pins `podman-compose==1.6.0` through `uvx`.
2. Podman returns bare 64-hex image IDs in places where Docker returns a
   `sha256:` prefix. The bridge and host witness now normalize the exact same
   immutable ID representation.
3. Real Harbor emits UTC timestamps with `+00:00` and absolute task paths.
   The bridge emits canonical `Z`; the slice binds a declared task directory
   to its exact real path.
4. Podman copy requires the destination directory to exist. The bridge creates
   the snapshot root before export.
5. Direct Python imports used to leave `bridge/__pycache__`, making a green
   review dirty afterward. All bridge launches now set
   `PYTHONDONTWRITEBYTECODE=1`.
6. The two-phase host witness preserves the built image long enough to bind
   its immutable ID, then asks Harbor to delete it after the bridge slice.
   Cleanup first restores write access to the sealed snapshot.

Both executable bridge surfaces are byte-bound:

- interception bridge `1.0.0-r8.1`:
  `0c165966ced7f6ba9480993536e0538b9627452efbabc394dc195d353aac6baf`
- Podman compatibility launcher:
  `03181cef92cfe7427fa8823cd931f630cf50e0260c91172a057751730347e705`

Observed host evidence on Podman 5.7.0:

- targeted real host witness: **1 PASS / 0 FAIL / 0 SKIP**
- Benchmark Kit suite in the root run: **111 PASS / 0 FAIL / 0 SKIP**
- root `pnpm test`: exit 0 (foundation, hooks, typecheck, Core, Benchmark Kit)
- real host path traversed: official vendored wheel → Harbor → Podman task
  image/container → interception bridge → immutable workspace snapshot →
  native verifier → NDJSON evidence

---

## R7→R8 defect closure (Codex R7 findings)

| # | R7 finding | R8 fix | Proof |
|---|---|---|---|
| P0 | `declaredDone:false` accepted as valid claim | Strict claim schema (literal `true` + ISO + exact trialName) + claim/outcome mutual exclusivity; invalid counts as absent → quarantine | Mutation: forged false claim quarantines (VERIFIER_FAILURE, no claims, no claim event) + coexistence case |
| P0 | Substring exception + contradictory marker accepted as A2 block | Exact `=== "ShokuninGateBlocked"` + parsed marker (exact trialName, internal BLOCK) + corroborating BLOCK verdict, one shared `isProvenGateBlock()` for adapter and session | Mutation: NotShokuninGateBlocked + PASS marker rejected, job-level failure persisted, never blocked |
| P0 | Arbitrary uv/bridge inherit `wheel-verified` | Pure `resolveLaunchAuthority()`: wheel bytes vs official constant, bridge bytes vs versioned allowlist (throw on mismatch), caller-supplied `uvPath` always unverified; only system-resolved `uv` can establish authority | Authority unit tests (caller-selected executable, system uv, tampered bytes); session-level tampered-bridge test fails before any execution |
| boundary | Gate request/outcome contracts were declared but incompletely exercised | Outcome requires exact `trialName`; gate request requires a governed arm and exact realpath binding to `trialDir/workspace-snapshot` before evaluation | Schema test + foreign-snapshot mutation; gate decider called zero times |
| P1 | A0 logs fictitious `gate_evaluated` | Event pushed only for requested+observed gates | A0 baseline + timeout assertions contain zero gate events |
| P1 | Host test depends on global harbor binary | Readiness via `resolveLaunchAuthority` (uv-wheel) + real `docker info`; global-harbor preflight and `spawnSync("uv")` probe removed | Host test traverses session+slice or skips with explicit reason |
| P2 | `BRIDGE_VERSION` drift + handoff inaccuracies | `BRIDGE_VERSION = "1.0.0-r8"` (+ uv test asserts it); allowlist hash injected programmatically; file list below generated from `git diff` | Version test; diff-checked file table |
| blog | Ledger fsync hardening | Accepted backlog, unchanged (non-blocking per review) | — |

## R8 counter-review criteria mapping (review §Seuil de sortie R8)

- three P0 mutations rejected → named R8 mutation tests (false claim, forged block, counterfeit authority), all asserting rejection/quarantine, never completion
- R7 corrections still passing → full suite green (only intended expectation updates: uv-identity now cli-shape-only, A0 logs gateless)
- A0 has no gate events → baseline + timeout order assertions
- clean suite after declared integration build → typecheck + core build + benchmark-kit suite
- host witness via official launcher or explicit sole external blocker → uv-authority readiness, session+slice traversal, single SKIP with reason
- no extra theoretical hardening → scope limited to the seven mandated items (file table below)

---

## Current Verification Matrix

- **TypeScript**: `pnpm --filter @shokunin/benchmark-kit typecheck` → exit 0.
- **Tests**: Core prebuilt, then benchmark-kit → **111 PASS, 0 SKIP, 0 FAIL**.
- **Root suite**: `pnpm test` after the declared Core build → exit 0 (foundation, hooks, typecheck, Core and Benchmark Kit).
- **Bridge**: `--help-protocol` PASS; 5/5 witness scenarios PASS with real `run()`; uv-env import (name + version) PASS; bubblewrap wire-test PASS.
- **Host**: real Podman 5.7.0 slice PASS; the test is no longer skipped on this host.
- **Scope**: changes strictly under ZB2; `git diff --check` clean; managed Python launches leave no bridge `__pycache__`.
- **Allowlist integrity**: bridge and Podman launcher digests are recomputed from final bytes by the suite.

## Operational incident register — Podman/Daytona

- Harbor's Docker Compose command uses `--project-name` and `--project-directory`; podman-compose 1.6 rejects these Docker-only forms. Always prepend `bridge/podman-compat` to `PATH`; the launcher normalizes the flags and is integrity-bound to SHA-256 `5b86d78ae2bf64e73751e64f5fbadfda748cf7902c064d8163beebb36be72372`.
- Podman 5.7 rejects Harbor's short image names unless `docker.io` is explicitly configured. Use a temporary `/tmp/shokunin-registries.conf` with `unqualified-search-registries = ["docker.io"]` and export `CONTAINERS_REGISTRIES_CONF`; never silently alter global registry configuration.
- Daytona's `sandbox.id`, `snapshot`, and `build_info` are provider metadata, not OCI image digests. They must never be serialized as `imageId` or `sha256:*`; Daytona remains unqualified until a signed provider attestation contract exists.
- The first successful real A0 baseline used Podman local, Harbor 0.1.2, Codex 0.154.0 / `openai/gpt-5-mini`, task `cancel-async-tasks`, reward 1.0, cost 0.0216885 USD, duration 9m17s. It is baseline evidence only, not the complete Shokunin A0–A3 campaign.

---

## R8.1 Files Modified/Added (ZB2-only inventory)

- `bridge/shokunin_intercept_agent.py`: host-derived normalization, timestamp, container discovery and export fixes; version `1.0.0-r8.1`
- `bridge/podman-compat/docker`: new narrow, executable Podman compatibility launcher
- `src/adapters/bridge-allowlist.ts`: exact bridge and launcher digests
- `src/integration/vertical-slice.ts`: exact declared task-directory binding
- `src/sessions/harbor-bridge-session.ts`: no-bytecode bridge launch environment
- `tests/fixtures/bridge-witness.py`: realistic bare Podman image-ID witness
- `tests/harbor-adapter.test.ts`: launcher integrity and real two-phase host witness
- `CONTRACT_MIGRATION_R8_1.md`: formal migration/evidence receipt
- `MEMORY.md` / `HANDOFF.md`: R8.1 state and handoff

---

## Integration Owner disposition

1. Root clean-checkout build order is corrected by the Integration Owner:
   root `pretypecheck` builds Core before resolving its exported declarations.
2. R8/R8.1 migration receipts are acknowledged; there are no in-repo
   consumers beyond the sealed tests.
3. The interrupted reviewer sandbox was independently identified as an
   incomplete run (`finished_at:null`, ledger only `STARTED`, no NDJSON), then
   removed. The separate completed canonical run remains the G2 execution
   evidence and left zero owned residue.
4. `G2_CORE_RUNTIME_INTEGRATED` is sealed. The next milestone is Z5-S0, a
   read-only source scan in the Foundry; ZB5 remains unwritten until G2A.
