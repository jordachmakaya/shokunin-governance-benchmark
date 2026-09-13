# MEMORY — ZB3 Evaluation & Statistics Engine

## Milestone
ZB3 — Evals & Statistics Engine (Milestone 1B)

## Status
IMPLEMENTATION — building against frozen ZB2 contracts post G2B_Z5_COPY_VERIFIED.

## Key Design Decisions
1. **No `simple-statistics` dependency** — BCa bootstrap is implemented from scratch using Node.js crypto for seeded PRNG (mulberry32). No external stats library to avoid version drift.
2. **Substitutability contract** — `IEvalsEngine` interface matches the master plan §6.3 signature exactly.
3. **Pairing key** — JSON serialization of `[campaignId, taskId, repetitionIndex, runtimeId, runtimeVersion, model]` (injective and delimiter-safe).
4. **Missing pairs policy** — `MISSING_PAIR` attrition record, never silently zero-filled.
5. **`falseCompletionTerminal`** — only metric computable pre-qualification (from Harbor native verdict).
6. **Attrition** — tracked per arm, per failure classification, per reason.
