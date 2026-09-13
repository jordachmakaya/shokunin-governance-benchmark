# Hypothesis registry

Status: candidate freeze, pending independent G0 review.

## H1 — deterministic completion verification

External, locally deterministic completion checks reduce terminal false completion without materially degrading externally verified task success.

Null hypothesis: enabling the completion mechanism does not improve terminal false completion or task success after accounting for cost, latency, and infrastructure attrition.

### Arms

| Arm | Common measurement | Gate | Blocking | Recovery |
|---|---:|---:|---:|---:|
| A0 baseline | yes | no | no | no |
| A1 observer | yes | passive | no | no |
| A2 blocker | yes | active | yes | no |
| A3 recovery | yes | active | yes | maximum three attempts |

### Primary outcomes

- External task success from the native Harbor task verifier.
- Terminal false completion: terminal completion claim and failed native verifier.

### Conditional claim-level outcomes

Initial/intercepted false completion is published only when claim snapshots can be verified later through a parity-qualified isolated verifier path. Otherwise those fields remain `null`.

### Promotion status

`UNTESTED`. The ZB0 foundation does not constitute evidence for H1.
