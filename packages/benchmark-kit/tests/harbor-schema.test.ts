import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  harborJobConfigSchema,
  harborJobResultSchema,
  harborTrialResultSchema,
} from "../schemas/harbor.schema.js";
import { parseHarborJobYaml } from "../src/adapters/yaml-parser.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(thisDir, "../..");
const fixtureDir = resolve(packageRoot, "tests/fixtures/harbor");

function readJsonFixture(relativePath: string): unknown {
  const content = readFileSync(resolve(fixtureDir, relativePath), "utf8");
  return JSON.parse(content);
}

test("BLOCKER 3: parses real job-config.yaml and validates with harborJobConfigSchema", () => {
  const yamlContent = readFileSync(resolve(fixtureDir, "job-config.yaml"), "utf8");
  const parsedYaml = parseHarborJobYaml(yamlContent);

  assert.equal(parsedYaml["job_name"], "oracle-job");
  assert.equal(parsedYaml["n_attempts"], 1);
  assert.equal(parsedYaml["timeout_multiplier"], 1.0);

  // Validate the parsed YAML through the strict Zod schema
  const validated = harborJobConfigSchema.parse(parsedYaml);
  assert.equal(validated.job_name, "oracle-job");
  assert.equal(validated.orchestrator.n_concurrent_trials, 1);
  assert.equal(validated.tasks.length, 1);
  assert.equal(validated.agents.length, 1);
  assert.equal(validated.tasks[0]?.path, "./oracle-task");
  assert.equal(validated.agents[0]?.name, "oracle");
});

test("BLOCKER 3: harborJobConfigSchema rejects empty-job missing both tasks and datasets", () => {
  const data = readJsonFixture("malformed/empty-job-config.json");
  // Missing tasks / agents / datasets
  assert.throws(() => {
    harborJobConfigSchema.parse(data);
  });

  // Explicitly empty tasks and datasets
  assert.throws(
    () => {
      harborJobConfigSchema.parse({
        job_name: "empty-job",
        tasks: [],
        datasets: [],
        agents: [{ name: "oracle" }],
      });
    },
    /Either datasets or tasks must be provided/,
  );
});

test("BLOCKER 3: harborTrialResultSchema rejects empty rewards dictionary fail-closed", () => {
  const data = readJsonFixture("malformed/empty-rewards-dict.json");
  assert.throws(
    () => {
      harborTrialResultSchema.parse(data);
    },
    /verifier_result\.rewards must not be empty/,
  );
});

test("harborJobConfigSchema validates job config json without in-memory mutation", () => {
  // Read job-level config.json directly from disk
  const data = readJsonFixture("jobs/oracle-job/config.json");
  const parsed = harborJobConfigSchema.parse(data);
  assert.equal(parsed.job_name, "oracle-job");
  assert.equal(parsed.n_attempts, 1);
  assert.equal(parsed.orchestrator.n_concurrent_trials, 1);
  assert.equal(parsed.tasks.length, 1);
  assert.equal(parsed.agents.length, 1);
  assert.equal(parsed.tasks[0]?.path, "oracle-task");
  assert.equal(parsed.agents[0]?.name, "oracle");
});

test("harborJobResultSchema validates job result json", () => {
  const data = readJsonFixture("jobs/oracle-job/result.json") as Record<string, unknown>;
  const parsed = harborJobResultSchema.parse(data);
  // Independent invariant assertions: UUID regex and expected job ID
  assert.match(parsed.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(parsed.id, "aa6ea252-9817-4c82-b432-4f6bf957d3e3");
  assert.equal(parsed.n_total_trials, 1);
  assert.equal(parsed.stats.n_trials, 1);
  assert.equal(parsed.stats.n_errors, 0);
  assert.ok(parsed.stats.evals["oracle__adhoc"]);
});

test("harborTrialResultSchema validates canonical oracle task result with LocalTaskId object", () => {
  const data = readJsonFixture(
    "jobs/oracle-job/oracle-task__fixture/result.json",
  ) as Record<string, unknown>;
  const parsed = harborTrialResultSchema.parse(data);
  // Independent invariant assertions: UUID regex, canonical oracle ID, and file:// URI regex
  assert.match(parsed.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(parsed.id, "e5f342af-b755-4208-9ebf-9f8dee679189");
  assert.equal(parsed.task_name, "oracle-task");
  assert.equal(parsed.trial_name, "oracle-task__fixture");
  assert.match(parsed.trial_uri, /^file:\/\/.+\/jobs\/oracle-job\/oracle-task__fixture$/);
  assert.deepEqual(parsed.task_id, { path: "oracle-task" });
  assert.equal(parsed.task_checksum, "19fc07d660632466aca155fbd818e25ad479f92bc409c4fcdbfaafcc982a5dd1");
  assert.equal(parsed.config.task.path, "oracle-task");
  assert.equal(parsed.config["trials_dir"], "jobs/oracle-job");
  assert.equal(parsed.config.agent.name, "oracle");
  assert.equal(parsed.agent_info.name, "oracle");
  assert.equal(parsed.agent_info.version, "1.0.0");
  assert.ok(parsed.verifier_result !== null);
  assert.equal(parsed.verifier_result.rewards["reward"], 1.0);
  assert.notEqual(parsed.agent_result, null);
  assert.equal(parsed.agent_result?.n_input_tokens, null);
  assert.equal(parsed.agent_result?.cost_usd, null);

  // Assert authentic phase timings
  assert.ok(parsed.environment_setup);
  assert.ok(new Date(parsed.environment_setup.finished_at).getTime() >= new Date(parsed.environment_setup.started_at).getTime());
  assert.ok(parsed.agent_setup);
  assert.ok(new Date(parsed.agent_setup.finished_at).getTime() >= new Date(parsed.agent_setup.started_at).getTime());
  assert.ok(parsed.agent_execution);
  assert.ok(new Date(parsed.agent_execution.finished_at).getTime() >= new Date(parsed.agent_execution.started_at).getTime());
  assert.ok(parsed.verifier);
  assert.ok(new Date(parsed.verifier.finished_at).getTime() >= new Date(parsed.verifier.started_at).getTime());
});

test("harborTrialResultSchema rejects malformed missing-rewards fixture fail-closed", () => {
  const data = readJsonFixture("malformed/missing-rewards.json");
  assert.throws(() => {
    harborTrialResultSchema.parse(data);
  });
});

test("harborTrialResultSchema rejects non-numeric reward fail-closed", () => {
  const data = readJsonFixture("malformed/non-numeric-reward.json");
  assert.throws(() => {
    harborTrialResultSchema.parse(data);
  });
});

test("harborTrialResultSchema rejects invalid timestamp strings fail-closed", () => {
  const data = readJsonFixture("malformed/invalid-timestamp.json");
  assert.throws(() => {
    harborTrialResultSchema.parse(data);
  });
});

test("harborTrialResultSchema rejects inverted execution time (finished_at < started_at)", () => {
  const data = readJsonFixture("malformed/inverted-execution-time.json");
  assert.throws(() => {
    harborTrialResultSchema.parse(data);
  });
});

test("harborTrialResultSchema rejects negative token counts fail-closed", () => {
  const data = readJsonFixture("malformed/negative-tokens.json");
  assert.throws(() => {
    harborTrialResultSchema.parse(data);
  });
});

test("harborTrialResultSchema rejects NaN and Infinity rewards fail-closed", () => {
  const base = {
    id: "439928b8-15e8-4bb9-af91-59f6955498a4",
    task_name: "oracle-task",
    trial_name: "oracle-task__fixture",
    trial_uri: "file:///tmp/harbor/jobs/oracle-job/oracle-task__fixture",
    task_id: "oracle-task",
    task_checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    config: {
      task: { path: "./oracle-task" },
      agent: { name: "test-agent" },
    },
    agent_info: {
      name: "test-agent",
      version: "1.0.0",
    },
    verifier_result: {
      rewards: {
        reward: NaN,
      },
    },
  };

  assert.throws(() => {
    harborTrialResultSchema.parse(base);
  });

  assert.throws(() => {
    harborTrialResultSchema.parse({
      ...base,
      verifier_result: { rewards: { reward: Infinity } },
    });
  });
});

test("harbor schemas reject non-UUID identifiers fail-closed", () => {
  const jobResultData = readJsonFixture("jobs/oracle-job/result.json") as Record<string, unknown>;
  assert.throws(
    () => {
      harborJobResultSchema.parse({
        ...jobResultData,
        id: "not-even-a-uuid",
      });
    },
    /UUID/,
  );

  const trialResultData = readJsonFixture("jobs/oracle-job/oracle-task__fixture/result.json") as Record<string, unknown>;
  assert.throws(
    () => {
      harborTrialResultSchema.parse({
        ...trialResultData,
        id: "not-even-a-uuid",
      });
    },
    /UUID/,
  );
});

test("harbor schemas enforce authentic Harbor 0.1.2 required fields fail-closed", () => {
  const jobResultData = readJsonFixture("jobs/oracle-job/result.json") as Record<string, unknown>;
  // Missing started_at
  const { started_at: _s, ...missingStartedAt } = jobResultData;
  assert.throws(() => {
    harborJobResultSchema.parse(missingStartedAt);
  });

  // Missing n_total_trials
  const { n_total_trials: _n, ...missingTotalTrials } = jobResultData;
  assert.throws(() => {
    harborJobResultSchema.parse(missingTotalTrials);
  });

  const trialResultData = readJsonFixture("jobs/oracle-job/oracle-task__fixture/result.json") as Record<string, unknown>;
  // Missing trial_uri
  const { trial_uri: _u, ...missingUri } = trialResultData;
  assert.throws(() => {
    harborTrialResultSchema.parse(missingUri);
  });

  // Missing task_checksum
  const { task_checksum: _c, ...missingChecksum } = trialResultData;
  assert.throws(() => {
    harborTrialResultSchema.parse(missingChecksum);
  });

  // Missing agent_info
  const { agent_info: _a, ...missingAgentInfo } = trialResultData;
  assert.throws(() => {
    harborTrialResultSchema.parse(missingAgentInfo);
  });
});

test("parseHarborJobYaml parses complex nested structures and preserved # in strings", () => {
  const yamlWithCommentsAndNesting = `
job_name: complex-job
n_attempts: 2
environment:
  type: docker
  force_build: true
  delete: false
  kwargs:
    network_mode: bridge
custom_key: "value with # hashtag inside quotes" # real comment here
tasks:
  - path: ./task-1
agents:
  - name: agent-a
    model_name: "claude-3#special"
`;
  const parsed = parseHarborJobYaml(yamlWithCommentsAndNesting);
  assert.equal(parsed["job_name"], "complex-job");
  assert.equal(parsed["custom_key"], "value with # hashtag inside quotes");
  assert.deepEqual(parsed["environment"], {
    type: "docker",
    force_build: true,
    delete: false,
    kwargs: { network_mode: "bridge" },
  });

  const validated = harborJobConfigSchema.parse(parsed);
  assert.equal(validated.job_name, "complex-job");
  assert.equal(validated.environment?.type, "docker");
  assert.equal(validated.environment?.force_build, true);
});

test("parseHarborJobYaml rejects invalid or non-object YAML fail-closed", () => {
  // Empty content
  assert.throws(() => parseHarborJobYaml(""), /empty or invalid/);
  assert.throws(() => parseHarborJobYaml("   \n\n  "), /empty or invalid/);

  // YAML array at root
  assert.throws(() => parseHarborJobYaml("- item1\n- item2"), /key-value object mapping/);

  // YAML scalar at root
  assert.throws(() => parseHarborJobYaml("just-a-string"), /key-value object mapping/);
  assert.throws(() => parseHarborJobYaml("42"), /key-value object mapping/);

  // Malformed YAML
  assert.throws(() => parseHarborJobYaml("key: [unclosed"), /Failed to parse YAML manifest/);
});

test("harborTrialResultSchema rejects string task_id fail-closed (requires LocalTaskId or GitTaskId)", () => {
  const trialResultData = readJsonFixture(
    "jobs/oracle-job/oracle-task__fixture/result.json",
  ) as Record<string, unknown>;

  // Reject string task_id
  assert.throws(
    () => {
      harborTrialResultSchema.parse({
        ...trialResultData,
        task_id: "oracle-task", // rejected!
      });
    },
    /invalid_union|Invalid input/,
  );

  // Accept valid GitTaskId object
  const validGitTask = harborTrialResultSchema.parse({
    ...trialResultData,
    task_id: {
      path: "oracle-task",
      git_url: "https://github.com/shokunin/benchmarks",
      git_commit_id: "abcdef1",
    },
  });
  assert.deepEqual(validGitTask.task_id, {
    path: "oracle-task",
    git_url: "https://github.com/shokunin/benchmarks",
    git_commit_id: "abcdef1",
  });
});

test("harborJobConfigSchema proves resolved concurrency requires nested orchestrator", () => {
  // 1. Correct nested orchestrator controls concurrency to 1
  const validNested = harborJobConfigSchema.parse({
    job_name: "oracle-job",
    orchestrator: {
      n_concurrent_trials: 1,
    },
    tasks: [{ path: "./oracle-task" }],
    agents: [{ name: "oracle" }],
  });
  assert.equal(validNested.orchestrator.n_concurrent_trials, 1);

  // 2. Erroneous root concurrency is ignored by Harbor model, falling back to default 4
  const erroneousRoot = harborJobConfigSchema.parse({
    job_name: "oracle-job",
    n_concurrent_trials: 1, // root field does NOT affect orchestrator
    tasks: [{ path: "./oracle-task" }],
    agents: [{ name: "oracle" }],
  });
  assert.equal(erroneousRoot.orchestrator.n_concurrent_trials, 4);
});

test("harborEnvironmentTypeSchema strictly enforces official Harbor 0.1.2 environments", () => {
  const validEnvs = ["docker", "daytona", "e2b", "modal", "runloop"] as const;
  for (const env of validEnvs) {
    const validConfig = harborJobConfigSchema.parse({
      job_name: "env-job",
      environment: { type: env },
      tasks: [{ path: "./oracle-task" }],
      agents: [{ name: "oracle" }],
    });
    assert.equal(validConfig.environment?.type, env);
  }

  // "local" and "k8s" are NOT valid environments in Harbor 0.1.2
  assert.throws(
    () => {
      harborJobConfigSchema.parse({
        job_name: "env-job",
        environment: { type: "local" },
        tasks: [{ path: "./oracle-task" }],
        agents: [{ name: "oracle" }],
      });
    },
    /invalid_value|invalid_enum_value|Invalid option|Invalid input/,
  );

  assert.throws(
    () => {
      harborJobConfigSchema.parse({
        job_name: "env-job",
        environment: { type: "k8s" },
        tasks: [{ path: "./oracle-task" }],
        agents: [{ name: "oracle" }],
      });
    },
    /invalid_value|invalid_enum_value|Invalid option|Invalid input/,
  );
});

test("harborJobConfigSchema allows datasets or tasks", () => {
  // Tasks only
  const tasksOnly = harborJobConfigSchema.parse({
    job_name: "tasks-only",
    tasks: [{ path: "./task-1" }],
    agents: [{ name: "oracle" }],
  });
  assert.equal(tasksOnly.tasks.length, 1);
  assert.equal(tasksOnly.datasets.length, 0);

  // Datasets only
  const datasetsOnly = harborJobConfigSchema.parse({
    job_name: "datasets-only",
    datasets: [{ path: "./dataset-1" }],
    agents: [{ name: "oracle" }],
  });
  assert.equal(datasetsOnly.tasks.length, 0);
  assert.equal(datasetsOnly.datasets.length, 1);
});

test("harborOrchestratorTypeSchema allows only local orchestrator, rejects modal fail-closed", () => {
  const valid = harborJobConfigSchema.parse({
    job_name: "local-job",
    orchestrator: { type: "local" },
    tasks: [{ path: "./oracle-task" }],
    agents: [{ name: "oracle" }],
  });
  assert.equal(valid.orchestrator.type, "local");

  // modal is not supported as an orchestrator type in Harbor 0.1.2
  assert.throws(
    () => {
      harborJobConfigSchema.parse({
        job_name: "modal-job",
        orchestrator: { type: "modal" },
        tasks: [{ path: "./oracle-task" }],
        agents: [{ name: "oracle" }],
      });
    },
    /invalid_literal|Invalid literal|invalid_value|expected "local"/,
  );
});

test("harborJobDatasetSchema rejects dataset missing both path and name fail-closed", () => {
  // Empty dataset object without path or name is rejected
  assert.throws(
    () => {
      harborJobConfigSchema.parse({
        job_name: "invalid-dataset-job",
        datasets: [{}],
        agents: [{ name: "oracle" }],
      });
    },
    /Dataset configuration must specify either non-empty 'path' or 'name'/,
  );

  // Valid with path
  const withPath = harborJobConfigSchema.parse({
    job_name: "path-dataset-job",
    datasets: [{ path: "./my-dataset" }],
    agents: [{ name: "oracle" }],
  });
  assert.equal(withPath.datasets?.[0]?.path, "./my-dataset");

  // Valid with name
  const withName = harborJobConfigSchema.parse({
    job_name: "name-dataset-job",
    datasets: [{ name: "terminal-bench" }],
    agents: [{ name: "oracle" }],
  });
  assert.equal(withName.datasets?.[0]?.name, "terminal-bench");
});

test("harborTrialResultSchema rejects short/invalid task_checksum fail-closed", () => {
  const trialResultData = readJsonFixture(
    "jobs/oracle-job/oracle-task__fixture/result.json",
  ) as Record<string, unknown>;

  // Rejects "x"
  assert.throws(
    () => {
      harborTrialResultSchema.parse({
        ...trialResultData,
        task_checksum: "x",
      });
    },
    /Task checksum must be a 64-character hexadecimal SHA-256 hash/,
  );
});

test("official Harbor 0.1.2 Pydantic models validate all on-disk fixtures and roundtrip via validate-fixtures.py", async () => {
  const { spawnSync } = await import("node:child_process");
  const scriptPath = resolve(packageRoot, "tests/validate-fixtures.py");
  const lockPath = resolve(
    packageRoot,
    "tests/fixtures/harbor/requirements.lock",
  );
  const wheelPath = resolve(
    packageRoot,
    "tests/fixtures/harbor/vendor/harbor-0.1.2-py3-none-any.whl",
  );

  // Mechanical verification of wheel integrity before execution
  const EXPECTED_WHEEL_SHA256 =
    "1478347edbfcc1ced2122815a67392dada4a40d715972a2e5a280858d457b7a5";
  const wheelBytes = readFileSync(wheelPath);
  const actualHash = createHash("sha256").update(wheelBytes).digest("hex");
  assert.equal(
    actualHash,
    EXPECTED_WHEEL_SHA256,
    `Vendored Harbor wheel SHA-256 mismatch: got ${actualHash}, expected ${EXPECTED_WHEEL_SHA256}`,
  );

  const proc = spawnSync(
    "uv",
    [
      "run",
      "--python",
      "3.12",
      "--with-requirements",
      lockPath,
      "--with",
      wheelPath,
      "python3",
      scriptPath,
    ],
    { encoding: "utf8" },
  );

  assert.equal(
    proc.status,
    0,
    `validate-fixtures.py failed with exit code ${proc.status}: ${proc.stderr}`,
  );
  assert.match(proc.stdout, /ALL_OFFICIAL_HARBOR_FIXTURES_AND_ROUNDTRIP_VALIDATED_SUCCESSFULLY/);
});

test("vendored Harbor wheel integrity check rejects tampered wheel fail-closed", async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const EXPECTED_WHEEL_SHA256 =
    "1478347edbfcc1ced2122815a67392dada4a40d715972a2e5a280858d457b7a5";
  const wheelPath = resolve(
    packageRoot,
    "tests/fixtures/harbor/vendor/harbor-0.1.2-py3-none-any.whl",
  );

  // Read actual authentic wheel bytes and mutate a single byte in a copy
  const genuineBytes = readFileSync(wheelPath);
  const tamperedBytes = Buffer.from(genuineBytes);
  const lastIdx = tamperedBytes.length - 1;
  const currentVal = tamperedBytes[lastIdx] ?? 0;
  tamperedBytes[lastIdx] = currentVal ^ 0xff;

  const tempDir = mkdtempSync(join(tmpdir(), "tampered-wheel-test-"));
  try {
    const tamperedWheelPath = join(tempDir, "harbor-0.1.2-py3-none-any.whl");
    writeFileSync(tamperedWheelPath, tamperedBytes);

    // Verify hash is strictly mismatched
    const tamperedHash = createHash("sha256").update(tamperedBytes).digest("hex");
    assert.notEqual(tamperedHash, EXPECTED_WHEEL_SHA256);

    // Verify integrity validation function rejects the tampered copy of the genuine artifact
    const verifyWheelIntegrity = (filePath: string): void => {
      const bytes = readFileSync(filePath);
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== EXPECTED_WHEEL_SHA256) {
        throw new Error(
          `Vendored wheel SHA-256 integrity failure: expected ${EXPECTED_WHEEL_SHA256}, got ${hash}`,
        );
      }
    };

    assert.throws(
      () => verifyWheelIntegrity(tamperedWheelPath),
      /Vendored wheel SHA-256 integrity failure/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
