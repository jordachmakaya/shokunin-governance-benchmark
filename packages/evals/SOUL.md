# SOUL — ZB3 Evaluation & Statistics Engine

## Identity
This is `packages/evals` — the statistical evaluation engine for the Shokunin H1 benchmark.

## Purpose
Compute honest, reproducible statistics from `BenchmarkTrial` records produced by ZB2.
Never invent metrics. Never fabricate results. Null unless qualified.

## Invariants
1. All inputs are `readonly BenchmarkTrial[]` from ZB2 frozen contracts — never raw Harbor output.
2. Paired comparison keys: `campaignId + task.id + repetitionIndex + execution.runtimeId + execution.runtimeVersion + execution.model`.
3. Missing pairs are never coerced to zero — they trigger `AttritionRecord` entries.
4. Bootstrap BCa: actual bias-correction `z0` + jackknife acceleration `a` — not percentile intervals.
5. Minimum 10,000 resamples. Seed written into every report.
6. All p-values are two-sided bootstrap estimates, not asymptotic.
7. `falseCompletionInitial`, `falseCompletionIntercepted` remain `null` until snapshot verification parity is proven.
8. Only `falseCompletionTerminal` (derived from Harbor final verdict) may be non-null pre-qualification.
9. Infrastructure failures are classified, never silently excluded.
10. Causal order is preserved: A0 → A1 → A2 → A3 per task cluster.
