# H1 — Deterministic Completion Verification

## Hypothesis

External, locally deterministic completion checks reduce terminal false completion without materially degrading externally verified task success after accounting for cost, latency, and infrastructure attrition.

## Primary outcomes

- Native Harbor task-verifier success rate.
- Terminal false-completion rate: terminal completion claim with failed native verifier.

## Secondary outcomes

- Cost and duration overhead.
- Gate detection/interception where qualified.
- Recovery success for A3, bounded to three attempts.

## Analysis

Trials are paired by campaign, task, repetition, runtime, runtime version, and model. Primary comparisons use a task-clustered paired BCa bootstrap with at least 10,000 resamples and a preregistered seed. Infrastructure attrition is retained and reported in ITT and sensitivity analyses.

## Status

PREREGISTERED — no pilot or confirmatory result is contained here. The pilot
cannot launch until the immutable ten-task manifest and runtime qualification
are committed and hash-verified; A3 remains ineligible until controlled resume
is proven.
