# Methodology

Status: candidate freeze, pending independent G0 review.

## Control planes

- Development hooks govern contributors to this repository.
- Common measurement records claims identically in A0–A3.
- Experimental treatment enables only the behavior declared by each arm.
- The Harbor task verifier remains inaccessible during agent execution.

## Reproducibility manifest

Every planned trial records campaign, task, arm, repetition, runtime and version, model, prompt/config hashes, container digest, timeouts, budgets, and the exact Harbor job manifest.

## Runtime qualification

A runtime must prove its stop signal, claim extraction, session resume, feedback, usage telemetry, and trajectory behavior. A runtime without controlled resume support is ineligible for A3.

## Infrastructure failures

Every attempt is retained and classified as exogenous infrastructure, agent runtime, governance, or verifier failure. Only predeclared exogenous failures may be excluded from the primary analysis. Attrition, replacement links, intention-to-treat, and sensitivity analyses are reported.

## Pilot

The apparatus pilot contains exactly `10 tasks × 4 arms × 2 repetitions = 80 planned trials`, excluding separately reported replacement attempts. It estimates variance and validates measurement; it cannot support an effectiveness claim.

## Confirmatory analysis

The confirmatory sample size is selected after the pilot and frozen before confirmatory outcomes are inspected. Analysis uses a seeded, task-clustered paired BCa bootstrap with at least 10,000 resamples. Effect sizes and confidence intervals are primary; any p-value is two-sided and secondary.

## Publication

Raw traces, snapshots, prompts, and implementation remain private. Public aggregates are deterministically generated and labeled audit-only unless the executable artifact required for independent reproduction is actually accessible.
