# Threats to validity

Status: living document; initial ZB0 registry.

- Task or model contamination.
- Provider/model drift despite stable marketing identifiers.
- Runtime-specific stop and resume behavior.
- Hidden differences in prompts, tools, timeouts, or attempt budgets.
- Instrumentation overhead or treatment leakage into A0.
- Task-level verifier defects or nondeterminism.
- Attrition correlated with an experimental arm.
- Treating repeated trials of one task as independent observations.
- Claim-level counterfactuals inferred without externally verified snapshots.
- Selection bias from an unrepresentative pilot subset.
- Private implementation limiting independent reproducibility.
- Secrets or proprietary content leaking through telemetry or public artifacts.
