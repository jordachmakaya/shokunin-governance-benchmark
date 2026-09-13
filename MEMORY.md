# Repository memory

## Truth map

| Question | Authority |
|---|---|
| What is this laboratory proving? | `docs/HYPOTHESES.md` |
| What experimental rules apply? | `docs/METHODOLOGY.md` |
| What can invalidate a result? | `docs/THREATS_TO_VALIDITY.md` |
| Who may write where? | `.shokunin/systems/ACTIVE_ASSIGNMENTS.json` |
| Where are system boundaries declared? | `.shokunin/systems/SYSTEM_REGISTRY.json` |
| Where are development hooks defined? | `.shokunin/hooks/HOOKS_REGISTRY.json` |
| What is the current gate? | `.shokunin/BENCHMARK_REPO.json` |

## Current state

- Phase: `P3_H1_PILOT_READY`.
- A project-owner-authorized integration window reopened the minimum ZB2, ZB3,
  ZB5, and ZB6 surfaces needed to replace the placeholder H1 executor and
  correct evidence semantics. The exact scope is recorded in
  `benchmarks/execution-zone/manifests/H1_ZB2_RUNTIME_MIGRATION.json`.
- The migration is now commit-bound to `d1676178fe001e3b47d07c759032ff93c435ef3a`, independently reviewed by Agy (`PASS`), and represented by refreshed G2/G3/G4 seals. The pilot remains a separate execution decision.
- Codex is the active Integration Owner for the bounded migration roots listed
  in `ACTIVE_ASSIGNMENTS.json`; all other actors remain `REVIEW_ONLY`.
- Root `pnpm test` is `PASS`: hooks 14/14, Core 17/17, Benchmark Kit 116/116,
  Evals 41/41, CLI 5/5, including the real Podman host witness. The H1 executor
  unit suite is 5/5.
- Runtime qualification is `PASS` for capability only: Codex 0.154.0,
  `openai/gpt-5-mini`, one controlled recovery, terminal Harbor reward 1, and
  preserved trajectory/usage evidence. It is not pilot efficacy evidence.
- Ten official H1 task images are locally resolved and frozen by OCI
  RepoDigest. Internal runtime bytes, Node, Harbor wheel, and bridge are bound
  by hashed manifests.
- Historical scratch A1/A2 records and all repair smokes remain quarantined as
  internal diagnostics. The latest cancel-async-tasks A3 gate converged after
  two retries but Harbor returned reward 0; no Shokunin effectiveness claim
  exists.
- Real H1 pilot launch is technically ready; no pilot has been run after this reseal. Results remain non-confirmatory pilot apparatus evidence until the 80 trials complete and are audited.

## H1 pilot checkpoint (2026-09-12)

- H1 pilot `H1-pilot-001` is paused after 55/80 trial records. The run is not
  active and has no final aggregate file; do not treat the checkpoint as a
  completed benchmark.
- Current provisional counts from the ignored raw receipts: Harbor PASS 13,
  Harbor FAIL 19, gate BLOCK 31, classified `falseBlock` 4 and `falsePass` 3.
  A2/A3 gate-blocked trials without a Harbor verifier remain unclassified.
- The last session failed during `query-optimize` / `A3_recovering` / `r1`
  (`TRIAL_FAILED`, phase `session`). Preserve all raw receipts and resume by
  completing the remaining 25 preregistered trials; do not change the 80-trial
  denominator or retroactively repair this checkpoint.
- Checkpoint receipt hashes are recorded in
  `benchmarks/execution-zone/manifests/H1_PILOT_001_CHECKPOINT.json`.

## H1 timeout repair (2026-09-13)

- Root cause of the 55-trial stop: the `query-optimize` A3 trial exhausted
  Harbor's single `agent.timeout_sec = 900` budget while performing bounded
  recovery. Harbor raised `AgentTimeoutError`; the local executor persisted a
  `TRIAL_FAILED` session record and stopped fail-closed. This was not a Harbor
  55-trial quota or provider rate limit.
- Repair: A3 H1 jobs now use `timeout_multiplier = 4` (A0-A2 remain `1`),
  preserving the 80-trial denominator while allowing the initial attempt plus
  three controlled recoveries to complete inside one Harbor trial. The change
  is bound in the runtime code manifest and experiment manifest.
- Pilot validation passes after the repair. The next launch must start from a
  clean worktree and retain the prior 55 records as an incomplete checkpoint;
  the remaining 25 preregistered trials are still required.
