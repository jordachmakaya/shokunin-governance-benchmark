# Contract Migration Receipt — ZB2.2-R8.1

## Purpose

R8.1 closes the real-host evidence gap left by R8. It does not change the
benchmark hypothesis or scoring contract. It makes the existing Harbor 0.1.2
vertical slice executable and truthful on the available Podman 5.7.0 host.

## Runtime-visible changes

| Surface | R8 behavior | R8.1 behavior |
|---|---|---|
| Bridge version | `1.0.0-r8` | `1.0.0-r8.1`, independently byte-allowlisted |
| Podman image ID | Bare 64-hex ID could fail Docker-shaped validation | Canonicalized to `sha256:<64 hex>` before comparison/evidence |
| Bridge timestamps | Python emitted `+00:00`, rejected by the strict JS ISO parser | UTC emitted with canonical `Z` |
| Harbor task identity | Only the short task name was accepted | A declared task directory is bound to its exact resolved absolute path |
| Workspace export | Destination parent was assumed to exist | Snapshot root is created before container copy |
| Python bridge loading | Could create `bridge/__pycache__` | `PYTHONDONTWRITEBYTECODE=1` on every managed bridge launch |
| Harbor-on-Podman | Harbor's Docker Compose CLI shape was unavailable | Byte-bound compatibility launcher supplies the observed required surface |

## Podman compatibility authority

The executable `bridge/podman-compat/docker` is deliberately narrow:

- non-compose commands execute the resolved Podman binary;
- `compose cp` maps the Harbor `main:` service to the actual Podman container;
- `compose exec` removes Harbor's forced interactive flags and executes in the
  actual Podman container;
- remaining compose commands execute pinned `podman-compose==1.6.0` via `uvx`.

Its exact SHA-256 is
`03181cef92cfe7427fa8823cd931f630cf50e0260c91172a057751730347e705`.
The suite recomputes this digest from the executable bytes and asserts its
execute mode. A changed launcher therefore fails before it can count as a
trusted laboratory path.

## Compatibility and consumer action

- Existing Docker hosts keep the native Docker path and do not use the shim.
- Podman hosts require `podman` and `uvx`; the pinned compose package is
  resolved by `uvx`.
- Consumers comparing bridge attestations must allow version `1.0.0-r8.1` and
  its exact digest recorded in `src/adapters/bridge-allowlist.ts`.
- No root configuration, lockfile, or file outside `packages/benchmark-kit/**`
  is changed.

## Acceptance evidence

On the available Podman 5.7.0 host:

- targeted real host witness: 1 PASS / 0 FAIL / 0 SKIP;
- root test run: exit 0;
- Benchmark Kit: 111 PASS / 0 FAIL / 0 SKIP;
- the run traversed the vendored official wheel, real Harbor task container,
  interception bridge, immutable exported snapshot, native verifier, and
  persisted NDJSON evidence.

## Post-review acceptance

Actor `buffy`, running Mimo-v2.5 independently from the R8.1 implementation,
returned `PASS`. Codex then accepted the result in an explicitly authorized
Integration Owner window after independently distinguishing and removing one
interrupted reviewer sandbox from the completed canonical evidence.

`G2_CORE_RUNTIME_INTEGRATED` is sealed `PASS` at
`2026-09-10T09:47:30.000Z`. This authorizes Z5-S0 source selection only. It
does not authorize a ZB5 copy before `G2A_Z5_SOURCE_SELECTION_FROZEN`.
