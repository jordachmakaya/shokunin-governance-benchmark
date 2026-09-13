# Shokunin, in one page

Shokunin is a governance layer for AI-assisted software engineering. It is designed
for teams that want coding agents to behave like accountable collaborators instead of
one-shot code generators.

## The problem

An agent can produce a convincing diff while still being wrong. In a long-running or
multi-agent project, the common failure modes are predictable:

- context is lost or becomes stale between sessions;
- the agent expands the scope of a task without permission;
- “done” is declared before the requirement is actually verified;
- tests are green but do not prove the business requirement;
- parallel agents create conflicting or incompatible changes;
- nobody can reconstruct what was decided, by whom, and on what evidence.

These are process failures as much as model failures. A better prompt alone cannot
provide durable state, independent verification, or release authority.

## The operating model

Shokunin divides the software lifecycle into bounded zones. Each zone has a defined
responsibility, inputs, outputs, write scope, and exit conditions. Cross-cutting gates
check the boundary between zones and can stop the workflow when evidence is missing,
stale, or contradictory.

The model is intentionally fail-closed:

1. work is performed inside a declared scope;
2. artifacts are checked against the real filesystem;
3. tests and security checks produce evidence rather than assertions in prose;
4. sealed artifacts are hash-bound so later changes are detectable;
5. release operations require an explicit, auditable proof;
6. unavailable tooling is reported as `BLOCKED`, not mislabelled as success.

The human remains the decision-maker for consequential product and release choices.
The harness supplies structure, evidence, and stop authority.

## What this benchmark tests

The H1 completion-verification benchmark tests one concrete Shokunin claim:

> **`DECLARED DONE` is not the same as `VERIFIED DONE`.**

An agent can report that a task is complete. Shokunin says that report must not become
success until an independent verifier confirms the required behavior and the evidence
is available. H1 measures whether that promise is enforced in practice: incomplete
work should be rejected, while contract-satisfying work should be accepted.

![Declared completion passes through independent verification](../assets/readme/declared-vs-verified.png)

It runs the same externally verified coding tasks under four controlled operating
modes (A0–A3). The benchmark records terminal outcomes, verifier evidence, false
completion claims, tooling blocks, retries, and resource usage. It does not rank a
model from one anecdotal success and it does not claim universal superiority.

The useful comparison is the shape of the error surface:

| Outcome | Meaning |
| --- | --- |
| `PASS` | The independent verifier accepted the required behavior. |
| `FAIL` | The verifier found that the requirement was not satisfied. |
| `BLOCKED` | Required tooling or evidence was unavailable; no success is inferred. |
| False completion | The agent declared success but the terminal evidence disagreed. |

## Why the distinction matters

The benchmark is aimed at engineering leaders who need to answer practical questions:

- Can an agent be trusted with a bounded change?
- Does a new harness reduce rework and false confidence?
- What happens when a tool is missing or a run times out?
- Can another engineer reproduce the verdict from the sealed evidence?

The public repository contains the methodology, experiment contracts, testable
interfaces, manifests, and aggregate results. Private implementation snapshots,
transcripts, workspace exports, credentials, and commercial source remain outside the
publication boundary.

For the experiment design and limitations, see [`METHODOLOGY.md`](METHODOLOGY.md),
[`HYPOTHESES.md`](HYPOTHESES.md), and [`THREATS_TO_VALIDITY.md`](THREATS_TO_VALIDITY.md).
