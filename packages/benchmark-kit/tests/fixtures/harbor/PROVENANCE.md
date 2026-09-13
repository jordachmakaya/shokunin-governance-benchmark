# Harbor Fixture Provenance & Specification Reference

## Upstream Release & Ground Truth

- **Framework**: Harbor Containerized Evaluation Framework (`harbor-framework/harbor`)
- **Reference PyPI Package**: `harbor==0.1.2`
- **Repository Reference**: `https://github.com/harbor-framework/harbor`
- **Official Wheel File**: `vendor/harbor-0.1.2-py3-none-any.whl` (vendored for offline hermetic testing)
- **Official Wheel SHA-256**: `1478347edbfcc1ced2122815a67392dada4a40d715972a2e5a280858d457b7a5`
- **Execution Invocation**:
  ```bash
  # Working directory: packages/benchmark-kit/tests/fixtures/harbor
  harbor run --config job-config.yaml
  ```

## Canonical Output Hierarchy

Harbor deterministically operates with an executable task definition and produces a four-tier output hierarchy upon execution:

```
tests/fixtures/harbor/
├── oracle-task/                                         # Executable Harbor task definition
│   ├── instruction.md                                   # Task prompt
│   ├── task.toml                                        # TaskConfig metadata and timeouts
│   ├── environment/
│   │   └── Dockerfile                                   # Alpine execution environment
│   ├── solution/
│   │   └── solve.sh                                     # Oracle solution script
│   └── tests/
│       └── test.sh                                      # Verifier test script emitting reward.json
├── job-config.yaml                                      # Declarative input manifest with orchestrator settings
└── jobs/
    └── oracle-job/
        ├── config.json                                  # Job-level resolved configuration (JobConfig)
        ├── result.json                                  # Global execution result & aggregate stats (JobResult)
        └── oracle-task__fixture/                        # Per-trial execution directory
            ├── config.json                              # Resolved task trial configuration (TrialConfig)
            └── result.json                              # Oracle verifier evaluation & rewards (TrialResult)
```

## Guarantees & Verification

1. **Zero Development Hook Contamination**: No `.shokunin/hooks/` files or internal development configurations exist in these fixtures or anywhere in trial workspaces.
2. **Wheel Integrity**: The official vendored Harbor wheel (`vendor/harbor-0.1.2-py3-none-any.whl`) has its SHA-256 hash (`1478347edbfcc1ced2122815a67392dada4a40d715972a2e5a280858d457b7a5`) mechanically checked before execution in both TypeScript (`harbor-schema.test.ts`) and Python (`validate-fixtures.py`). Any tampering is rejected fail-closed.
3. **Reproducibility & Dependencies**: Pinned requirements are specified in `requirements.txt` (`harbor==0.1.2`, `pydantic>=2.11.7`, `pyyaml>=6.0.2`). While TypeScript/Node.js testing is 100% offline and frozen (`pnpm install --frozen-lockfile --offline`), the Python fixture validator relies on standard `uv` resolution for transitive dependencies (Pydantic, PyYAML).
4. **Machine-Independent Portability**: Fixture paths use portable relative locations (`trials_dir: "jobs/oracle-job"`) and portable file URIs (`trial_uri: "file:///workspace/jobs/oracle-job/oracle-task__fixture"`), avoiding any machine-specific user directory paths.
5. **Authentic Phase Timings**: All phase timings (`environment_setup`, `agent_setup`, `agent_execution`, `verifier`) are populated with genuine chronological `TimingInfo` timestamps matching real `Trial.run()` lifecycle execution.
6. **Authentic Schema Conformance**: Validated against `harborJobConfigSchema`, `harborJobResultSchema`, and `harborTrialResultSchema` and dual-validated directly against official Harbor 0.1.2 Pydantic models:
   - `JobConfig`: Requires `orchestrator.n_concurrent_trials` (default 4; explicit 1 in fixture), `timeout_multiplier`, `environment.type` in `["docker", "daytona", "e2b", "modal", "runloop"]`, and at least one task or dataset.
   - `JobResult`: Requires RFC 4122 UUID `id`, ISO-8601 `started_at`, non-negative integer `n_total_trials`, and structured `stats` (`n_trials`, `n_errors`, `evals`).
   - `TrialResult`: Requires RFC 4122 UUID `id`, `trial_uri`, `task_id` dictionary (`LocalTaskId` `{ "path": string }` or `GitTaskId`), SHA-256 `task_checksum` matching directory hash, fully resolved `config` (`task`, `agent`, `environment`, `verifier`), `agent_info` (`name`, `version`, `model_info`), `verifier_result` (`rewards`), and non-null chronological phase timings.
7. **Fail-Closed Behavioral Invariants**:
   - `rewards` must be non-empty and all values must be finite numeric values.
   - Timestamps must be valid ISO-8601 strings satisfying `started_at <= finished_at`.
   - String `task_id` values (e.g. `"oracle-task"`) fail closed — `task_id` must be an authentic object mapping (`LocalTaskId` or `GitTaskId`).
   - Fixtures are read and validated directly on-disk without in-memory mutations.
