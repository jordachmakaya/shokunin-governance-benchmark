# AGENT.md — ZB3 Evaluation & Statistics Engine

## Write Boundary
`packages/evals/**` exclusively.

## Read Boundary (frozen ZB2 contracts — read-only)
- `packages/benchmark-kit/contracts/trial.contract.ts`
- `packages/benchmark-kit/schemas/trial.schema.ts`

## Forbidden
- Do NOT import from `packages/benchmark-kit/src/**` (implementation internals)
- Do NOT write to any other writeRoot
- Do NOT seal G3_EVAL_PIPELINE_STABLE
- Do NOT launch real Harbor pilots
- Do NOT invent metrics, interpolate rewards, or backfill missing trials
