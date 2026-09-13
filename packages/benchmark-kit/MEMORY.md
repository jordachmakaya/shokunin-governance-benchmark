# MEMORY — Benchmark Kit Zone (ZB2)

## Current Milestone

- Milestone: `ZB2.2-R8.1 — Host-Proven Podman Compatibility & Evidence Hygiene`
- Status: Accepted and sealed after independent counter-review. The real host witness passes on Podman 5.7.0 with no skipped test.
- Delivery attribution: Codex, under the user's exceptional authorization to finish the token-cutoff handoff. R8 remains MIXED Muse Spark/Codex.
- Reviewer: actor `buffy`, model Mimo-v2.5; verdict `PASS`.
- Gate: `G2_CORE_RUNTIME_INTEGRATED` is **SEALED PASS**. ZB2 is read-only.
- Next gate: `G2A_Z5_SOURCE_SELECTION_FROZEN`; no ZB5 copy before it.
- Dependencies: `@shokunin/core` (contracts, schemas, CompletionGate, LocalCommandExecutor)

## Design Decisions

1. **Exact sidecars (R8 core)**: every bridge sidecar has a strict Zod
   contract — claim requires literal `declaredDone:true` + ISO timestamp +
   exact trialName; claim/outcome mutually exclusive by construction.
   Parseable-but-invalid files count as absence → quarantine, never trust.
   Outcomes require an exact trialName. Governed gate requests require the
   expected arm and a realpath exactly equal to the native trial's
   `workspace-snapshot`; foreign evidence is blocked before gate evaluation.
2. **Exact A2 proof (R8)**: `exception_type === "ShokuninGateBlocked"`
   (never substring), parsed `gate-blocked.json` with exact trialName and
   internal BLOCK, corroborating BLOCK `gate-verdict.json`. One shared
   `isProvenGateBlock()` helper serves adapter and session so the two gates
   cannot drift.
3. **Executed authority (R8)**: pure `resolveLaunchAuthority()` — wheel bytes
   vs official constant, bridge bytes vs versioned lab-owned allowlist,
   uv resolvable AND literally named `uv`; else cli-shape-only. Mocks can
   never yield wheel-verified. Attestation carries the allowlisted
   `bridgeVersion`.
4. **Honest A0 events (R8)**: `gate_evaluated` is logged only for requested
   and observed gates; A0 logs contain zero gate events.
5. **Host without globals (R8)**: readiness via the same uv+wheel authority
   the session executes; no global `harbor` binary probed or spawned.
6. **Contract migration** (Master Plan §11.6 item 3): see
   `CONTRACT_MIGRATION_R8.md`. Scope strictly ZB2. Root build order + real
   host slice proof belong to the Integration Owner / host environment.
   Ledger fsync hardening stays accepted backlog (non-blocking per review).
7. **Real Podman boundary (R8.1)**: Harbor 0.1.2's required Docker Compose
   surface is supplied by a minimal, versioned, byte-bound compatibility
   launcher. It pins `podman-compose==1.6.0`; translates only `compose cp` and
   `compose exec`; all other commands pass through to Podman/podman-compose.
8. **Host-derived corrections (R8.1)**: normalize Podman's bare image ID,
   emit canonical `Z` timestamps, bind Harbor's absolute task path, create the
   snapshot destination before copy, preserve then delete the two-phase image,
   and suppress Python bytecode residue. See `CONTRACT_MIGRATION_R8_1.md`.
9. **R8.1 evidence**: Podman 5.7.0 targeted witness 1/1 PASS; root suite exit
   0 with Benchmark Kit 111 PASS / 0 FAIL / 0 SKIP. The Integration Owner
   sealed G2 after independent acceptance and final residue verification.
