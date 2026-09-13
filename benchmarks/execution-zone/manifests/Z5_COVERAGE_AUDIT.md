# Z5 custody coverage audit

Status: pre-resclement audit; this document does not claim that H1 contains the complete Shokunin runtime.

## Coverage categories

| Category | Contents | H1 treatment status |
|---|---|---|
| Emitted treatment artifacts | `z5-zone-exit-audit`, `z5-metrics-evidence`, adapted completion/recovery/quality/forbidden policies | Available only to the declared treatment arms; never A0 |
| Private provenance archive | 16 exact CTO docs/rules/scripts and four backend sub-agent `AGENT.md` files listed in `Z5_COPY_RECEIPT.json` | Hash-bound custody evidence; never mounted in Harbor |
| Controller-only operational surface | `ZONE_TODO.md`, complete source `SOUL.md`/`AGENT.md` (only bounded ADAPT outputs are emitted), session/bootstrap/handover scripts, feature red-team, drift and ledger tooling | Not emitted to H1; used to operate and audit the benchmark repository |
| Unemitted sub-agent skills | Skills marked `REFERENCE_ONLY` (review context) or `EXCLUDE` (controller/security/maintenance) in the allowlist | Not injected into trial prompts or workspaces; adding them would redefine the treatment |

## Explicit limitation

H1 measures the preregistered completion-verification/recovery treatment derived from Z5, not every
Shokunin skill or operational script. Any claim must say “Z5 selected treatment surface”. A claim about
the complete Shokunin system requires a new experiment definition, reopened custody gates, and a new
allowlist; it cannot reuse the current Z5 hash or G2B seal.

## Cross-system dependency decision

The `context-engineering/epistemic-governance` processes, context-audit hooks, and
`professional-accountability` skill are **controller-plane dependencies**, not H1 treatment inputs.
They govern custody, review, escalation, and release decisions made by the benchmark operators. They
must run around the benchmark jobs (before/after sessions) and their evidence may be retained in the
private ledger, but they must not be copied into Harbor workspaces, prompts, or the Common Measurement
Plane. Injecting them into A1/A2/A3 would change context, feedback, or agent behavior and invalidate the
A0 comparison. A future benchmark of context lifecycle/epistemic governance belongs to H3, with its own
dataset, treatment definition, and custody gate.

The same rule applies to sub-agent-only skills such as accountability, code-health review, and
git-discipline: they are required to operate and review the repository, but are not silently claimed as
part of the Z5 treatment measured by H1.

## Nominative disposition map (current allowlist)

| Source path | Current allowlist classification | Disposition |
|---|---|---|
| `.shokunin/agents/cto/sub-agents/security_checker_backend/AGENT.md` | `REFERENCE_ONLY` | Controller review reference; not emitted to Harbor |
| `.shokunin/agents/cto/sub-agents/feature-redteam-attacker/AGENT.md` | `EXCLUDE` | Controller-only red-team role; not emitted |
| `.shokunin/agents/cto/sub-agents/feature-redteam-verifier/AGENT.md` | `EXCLUDE` | Controller-only red-team role; not emitted |
| `.shokunin/agents/cto/sub-agents/drift-auditor/AGENT.md` | `EXCLUDE` | Controller epistemic audit; not emitted |
| `.shokunin/agents/cto/sub-agents/clean-monitor/AGENT.md` | `EXCLUDE` | Controller escalation monitor; not emitted |
| `.shokunin/agents/cto/sub-agents/harness-maintainer/AGENT.md` | `EXCLUDE` | Repository maintenance role; not emitted |
| `.shokunin/processes/context-engineering/epistemic-governance/**` | `REFERENCE_ONLY`/`EXCLUDE` by file | Controller-plane process; never mounted in trials |
| `.shokunin/skills/accountability/professional-accountability/**` | Controller-only | Loaded by operators/sub-agents under their own governance, never by Harbor agents |
| `.shokunin/agents/cto/scripts/run-feature-redteam.ts`, `session-ledger.ts`, `z5-handoff.ts` | `REFERENCE_ONLY`/`EXCLUDE` | Operate custody and handover outside the trial workspace |

This map is a scope statement, not a claim that omitted bytes were copied. Any change from
`REFERENCE_ONLY`/`EXCLUDE` to emitted treatment requires a new source allowlist, acquisition bundle,
license review, arm-isolation review, and G2A/G2B rescellement.

## Required before H1

1. Independent reviewer accepts this scope or authorizes a new full-surface custody.
2. The task manifest, dataset digest, runtime qualification and G3/G4 seals are present.
