#!/usr/bin/env node
/** Canonical one-trial H1 executor. Gate checks use public task instructions only. */
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CompletionGate } from "../../../packages/core/dist/src/index.js";
import {
  BRIDGE_ALLOWLIST, HarborBridgeSession, OFFICIAL_HARBOR_WHEEL_SHA256,
  benchmarkTrialSchema, computeTaskChecksum, executeVerticalSlice,
} from "../../../packages/benchmark-kit/dist/src/index.js";

const EXECUTOR_COMMAND = "node benchmarks/execution-zone/executors/h1-executor.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RESULT_ROOT = resolve(REPO_ROOT, "benchmarks/execution-zone/raw-results");
const DATASET_ROOT = resolve(REPO_ROOT, "benchmarks/execution-zone/datasets/terminal-bench-2-1");
const WHEEL_PATH = resolve(REPO_ROOT, "packages/benchmark-kit/tests/fixtures/harbor/vendor/harbor-0.1.2-py3-none-any.whl");
const LOCK_PATH = resolve(REPO_ROOT, "packages/benchmark-kit/tests/fixtures/harbor/requirements.lock");
const BRIDGE_PATH = resolve(REPO_ROOT, "packages/benchmark-kit/bridge/shokunin_intercept_agent.py");
const EXECUTOR_PATH = fileURLToPath(import.meta.url);
// A3 may execute the initial agent plus three controlled recoveries inside one
// Harbor trial. Give that bounded protocol four task budgets so Harbor cannot
// cancel the final recovery at the single-attempt default deadline.
const H1_A3_TIMEOUT_MULTIPLIER = 4;

const TASK_SPECS = Object.freeze({
  "cancel-async-tasks": { checks: ["cancel-output", "cancel-contract"], exportPaths: ["/app"] },
  "configure-git-webserver": { checks: ["git-webserver-layout", "git-webserver-config"], exportPaths: ["/app", "/git", "/etc/nginx", "/var/www"] },
  "fix-code-vulnerability": { checks: ["vulnerability-report", "public-vulnerability-contract"], exportPaths: ["/app"] },
  "git-leak-recovery": { checks: ["recovered-secret", "git-cleanup"], exportPaths: ["/app"] },
  "large-scale-text-editing": { checks: ["vim-macro-contract", "vim-public-result"], exportPaths: ["/app"] },
  "pypi-server": { checks: ["pypi-package-contract", "pypi-server-live-probe"], exportPaths: ["/app"], probeKind: "pypi-server" },
  "query-optimize": { checks: ["sql-file-contract", "sql-output-equivalence"], exportPaths: ["/app"] },
  "git-multibranch": { checks: ["multibranch-git-layout", "multibranch-web-config"], exportPaths: ["/app", "/git", "/etc/nginx", "/var/www", "/etc/ssh"] },
  "sqlite-db-truncate": { checks: ["truncate-json-contract"], exportPaths: ["/app"] },
  "db-wal-recovery": { checks: ["wal-json-contract"], exportPaths: ["/app"] },
});

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function assertInside(root, path, label) {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${label} escapes its approved root`);
}

function parseTrialArgument(argv) {
  const flag = argv.indexOf("--trial-json");
  if (flag < 0 || !argv[flag + 1]) throw new Error("H1 executor requires --trial-json");
  let trial;
  try { trial = JSON.parse(argv[flag + 1]); } catch { throw new Error("H1 executor received malformed --trial-json"); }
  for (const key of ["campaignId", "experimentId", "taskId", "arm", "attestationNonce"]) {
    if (typeof trial?.[key] !== "string" || !trial[key]) throw new Error(`H1 executor requires ${key}`);
  }
  if (!/^[0-9a-f]{64}$/.test(trial.attestationNonce)) throw new Error("H1 executor requires a 256-bit hexadecimal attestation nonce");
  if (!Number.isInteger(trial.repetitionIndex) || trial.repetitionIndex < 0) throw new Error("H1 executor requires a non-negative repetitionIndex");
  if (!Object.hasOwn(TASK_SPECS, trial.taskId)) throw new Error(`Unregistered H1 task: ${trial.taskId}`);
  if (!["A0_baseline", "A1_observing", "A2_blocking", "A3_recovering"].includes(trial.arm)) throw new Error(`Unregistered H1 arm: ${trial.arm}`);
  const runtime = trial.runtime;
  if (!runtime || typeof runtime !== "object") throw new Error("H1 executor requires frozen runtime metadata");
  for (const key of ["runtimeId", "runtimeVersion", "model"]) if (typeof runtime[key] !== "string" || !runtime[key]) throw new Error(`Frozen runtime is missing ${key}`);
  const digest = runtime.containerDigests?.[trial.taskId];
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`Frozen runtime is missing the OCI digest for ${trial.taskId}`);
  return trial;
}

function readPublicTaskConfig(taskId) {
  const taskDir = resolve(DATASET_ROOT, taskId);
  assertInside(DATASET_ROOT, taskDir, "Task directory");
  const toml = readFileSync(resolve(taskDir, "task.toml"), "utf8");
  const instructionPath = resolve(taskDir, "instruction.md");
  const image = toml.match(/^docker_image\s*=\s*"([^"]+)"/m)?.[1];
  const timeouts = [...toml.matchAll(/^timeout_sec\s*=\s*([0-9.]+)/gm)].map((match) => Number(match[1]));
  const timeout = Math.max(...timeouts);
  if (!image || !Number.isFinite(timeout) || timeout <= 0 || !existsSync(instructionPath)) throw new Error(`Public task metadata is incomplete for ${taskId}`);
  return { taskDir, instructionPath, image, timeoutMs: Math.ceil(timeout * 1000) };
}

function walkFiles(root, maxBytes = 4 * 1024 * 1024) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) visit(path);
      else if (info.isFile() && info.size <= maxBytes) files.push(path);
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

function textCorpus(root) {
  return walkFiles(root, 1024 * 1024).map((path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } }).join("\n");
}

function runProcess(command, args, cwd, timeoutMs = 30_000) {
  return new Promise((resolveResult) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HOME: process.env.HOME ?? "/tmp", PYTHONDONTWRITEBYTECODE: "1" },
      stdio: ["ignore", "pipe", "pipe"], detached: true,
    });
    let stdout = "", stderr = "", timedOut = false;
    const append = (current, chunk) => (current + chunk.toString()).slice(-256_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }, timeoutMs);
    child.on("error", (error) => { stderr = append(stderr, Buffer.from(error.message)); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolveResult({ exitCode: code, signal, stdout, stderr, durationMs: Date.now() - started, timedOut }); });
  });
}

function requireFile(root, relativePath) {
  const path = resolve(root, relativePath);
  assertInside(root, path, "Gate input");
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Required public output is missing: ${relativePath}`);
  return path;
}

function copyForCheck(snapshotRoot, sourceName) {
  const tempRoot = mkdtempSync("/tmp/shokunin-h1-gate-");
  const source = resolve(snapshotRoot, sourceName);
  assertInside(snapshotRoot, source, "Gate copy source");
  const target = resolve(tempRoot, sourceName);
  cpSync(source, target, { recursive: true });
  return { tempRoot, target };
}

const PY_CANCEL_CONTRACT = String.raw`
import asyncio, importlib.util, inspect, pathlib
p = pathlib.Path('app/run.py'); assert p.is_file(), 'app/run.py missing'
spec = importlib.util.spec_from_file_location('candidate_run', p)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
assert inspect.iscoroutinefunction(m.run_tasks), 'run_tasks must be async'
async def check():
    active = 0; peak = 0; factory_calls = []; cleaned = []; started = asyncio.Event()
    async def job(index):
        nonlocal active, peak
        active += 1; peak = max(peak, active)
        if peak >= 2: started.set()
        try: await asyncio.Event().wait()
        finally: active -= 1; cleaned.append(index)
    def factory(index):
        def create():
            factory_calls.append(index)
            return job(index)
        return create
    runner = asyncio.create_task(m.run_tasks([factory(i) for i in range(4)], 2))
    await asyncio.wait_for(started.wait(), 3); runner.cancel()
    try: await asyncio.wait_for(runner, 3)
    except asyncio.CancelledError: pass
    assert peak <= 2, f'max_concurrent violated: {peak}'
    assert active == 0, f'running tasks leaked after cancellation: active={active}'
    assert all(index in range(4) for index in factory_calls), f'invalid factory index: {factory_calls}'
    assert sorted(cleaned) == sorted(factory_calls), f'cleanup did not run for every started task: started={factory_calls}, cleaned={cleaned}'
asyncio.run(check())
`;

const PY_SQL_EQUIVALENCE = String.raw`
import pathlib, sqlite3
root = pathlib.Path('app')
original = (root/'my-sql-query.sql').read_text(); solution = (root/'sol.sql').read_text()
def rows(sql):
    con = sqlite3.connect(f'file:{(root/"oewn.sqlite").resolve()}?mode=ro', uri=True)
    try: return con.execute(sql).fetchall()
    finally: con.close()
assert rows(solution) == rows(original), 'sol.sql output differs from the public reference query'
`;

const PY_VULNERABILITY_CONTRACT = String.raw`
import importlib.util, json, pathlib
root = pathlib.Path('app')
rows = [json.loads(line) for line in (root/'report.jsonl').read_text().splitlines() if line.strip()]
assert any(row.get('file_path') == '/app/bottle.py' and 'cwe-93' in [str(value).lower() for value in row.get('cwe_id', [])] for row in rows), 'report.jsonl is missing /app/bottle.py CWE-93'
spec = importlib.util.spec_from_file_location('candidate_bottle', root/'bottle.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
for value in ('header\\nname', 'header\\rname', 'header\\x00name'):
    try: module._hkey(value)
    except ValueError: pass
    else: raise AssertionError(f'_hkey accepted invalid header {value!r}')
assert module._hkey('content-type') == 'Content-Type'
`;

async function evaluateCheck(checkId, snapshotRoot, timeoutMs) {
  const app = resolve(snapshotRoot, "app");
  switch (checkId) {
    case "cancel-output": requireFile(snapshotRoot, "app/run.py"); return "app/run.py exists";
    case "cancel-contract": {
      const result = await runProcess("python3", ["-B", "-c", PY_CANCEL_CONTRACT], snapshotRoot, timeoutMs);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "public async contract failed");
      return "async concurrency and cancellation-cleanup contract passed";
    }
    case "git-webserver-layout": {
      const hook = requireFile(snapshotRoot, "git/server/hooks/post-receive");
      if ((statSync(hook).mode & 0o111) === 0) throw new Error("post-receive hook is not executable");
      requireFile(snapshotRoot, "git/server/HEAD"); return "bare repository and executable post-receive hook are present";
    }
    case "git-webserver-config": {
      const corpus = textCorpus(resolve(snapshotRoot, "nginx"));
      if (!/listen\s+8080\b/.test(corpus)) throw new Error("exported nginx configuration does not listen on port 8080");
      const hookText = readFileSync(resolve(snapshotRoot, "git/server/hooks/post-receive"), "utf8");
      if (!/(checkout|work-tree|GIT_WORK_TREE)/i.test(hookText)) throw new Error("post-receive hook has no deployment action");
      return "nginx port and deployment hook are declared";
    }
    case "vulnerability-report": {
      const rows = readFileSync(requireFile(snapshotRoot, "app/report.jsonl"), "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
      if (!rows.some((row) => row?.file_path === "/app/bottle.py" && Array.isArray(row.cwe_id) && row.cwe_id.map(String).some((id) => id.toLowerCase() === "cwe-93"))) throw new Error("report.jsonl does not declare /app/bottle.py with CWE-93");
      return "public vulnerability report contract passed";
    }
    case "public-vulnerability-contract": {
      const result = await runProcess("python3", ["-B", "-c", PY_VULNERABILITY_CONTRACT], snapshotRoot, timeoutMs);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "public vulnerability contract failed");
      return "public vulnerability report and _hkey behavior contract passed";
    }
    case "recovered-secret": {
      const value = readFileSync(requireFile(snapshotRoot, "app/secret.txt"), "utf8").trim();
      if (!/^secret\[[^\]\r\n]+\]$/.test(value)) throw new Error("secret.txt does not contain exactly one public-format secret");
      return "recovered secret has the required public format";
    }
    case "git-cleanup": {
      const repo = resolve(app, "repo");
      if (!existsSync(resolve(repo, ".git"))) throw new Error("app/repo is not a Git worktree");
      const result = await runProcess("git", ["-C", repo, "fsck", "--full", "--no-reflogs", "--unreachable"], snapshotRoot, timeoutMs);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "git fsck failed");
      if (/\b(dangling|unreachable)\b/i.test(`${result.stdout}\n${result.stderr}`)) throw new Error("rewritten repository retains unreachable or dangling objects");
      const corpus = walkFiles(repo).filter((path) => !path.includes(`${sep}.git${sep}`)).map((path) => { try { return readFileSync(path, "utf8"); } catch { return ""; } }).join("\n");
      if (/secret\[[^\]]+\]/.test(corpus)) throw new Error("secret remains in the repository worktree");
      return "repository is valid and contains no unreachable objects or public-format secret";
    }
    case "vim-macro-contract": {
      const script = readFileSync(requireFile(snapshotRoot, "app/apply_macros.vim"), "utf8");
      const lines = script.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (lines.some((line) => !/^(call setreg\('[abc]',\s*"(?:[^"\\]|\\.)*"\)|:%normal! @[abc]|:(?:wq|x))$/.test(line))) throw new Error("apply_macros.vim contains a command outside the public allowlist");
      const macros = [...script.matchAll(/call setreg\('([abc])',\s*"((?:[^"\\]|\\.)*)"\)/g)];
      if (new Set(macros.map((match) => match[1])).size !== 3 || macros.some((match) => !match[2])) throw new Error("registers a, b and c must each contain a non-empty macro");
      if (macros.reduce((sum, match) => sum + match[2].length, 0) >= 200) throw new Error("declared Vim macros exceed the public 200-keystroke limit");
      return "Vim macro allowlist and keystroke contract passed";
    }
    case "vim-public-result": {
      const tempRoot = mkdtempSync("/tmp/shokunin-h1-vim-");
      try {
        for (const name of ["input.csv", "expected.csv", "apply_macros.vim"]) cpSync(requireFile(snapshotRoot, `app/${name}`), resolve(tempRoot, name));
        const result = await runProcess("vim", ["-Nu", "NONE", "-n", "-Es", resolve(tempRoot, "input.csv"), "-S", resolve(tempRoot, "apply_macros.vim")], tempRoot, timeoutMs);
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "headless Vim execution failed");
        if (!readFileSync(resolve(tempRoot, "input.csv")).equals(readFileSync(resolve(tempRoot, "expected.csv")))) throw new Error("headless Vim output differs from expected.csv");
        return "headless Vim exits 0 and output matches expected.csv byte-for-byte";
      } finally { rmSync(tempRoot, { recursive: true, force: true }); }
    }
    case "pypi-package-contract": {
      const corpus = textCorpus(app);
      if (!/vectorops/.test(corpus) || !/0\.1\.0/.test(corpus) || !/def\s+dotproduct\s*\(/.test(corpus)) throw new Error("vectorops 0.1.0 with dotproduct is not fully declared in /app");
      return "vectorops name, version and dotproduct implementation are present";
    }
    case "pypi-server-live-probe": {
      const probe = JSON.parse(readFileSync(requireFile(snapshotRoot, "app/.shokunin-h1-service-probe.json"), "utf8"));
      if (probe.kind !== "pypi-server" || probe.endpointPassed !== true || probe.installPassed !== true) throw new Error(`live PyPI probe did not pass: ${JSON.stringify(probe)}`);
      return "live PyPI endpoint and package installation probe passed inside the task container";
    }
    case "sql-file-contract": {
      const sql = readFileSync(requireFile(snapshotRoot, "app/sol.sql"), "utf8").trim();
      if (!sql.endsWith(";") || /--|\/\*/.test(sql) || (sql.match(/;/g) ?? []).length !== 1) throw new Error("sol.sql must be one comment-free SQLite query terminated by one semicolon");
      return "single-query sol.sql contract passed";
    }
    case "sql-output-equivalence": {
      for (const name of ["app/oewn.sqlite", "app/my-sql-query.sql", "app/sol.sql"]) requireFile(snapshotRoot, name);
      const result = await runProcess("python3", ["-B", "-c", PY_SQL_EQUIVALENCE], snapshotRoot, timeoutMs);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "SQL output equivalence failed");
      return "sol.sql output equals the public reference query output";
    }
    case "multibranch-git-layout": {
      const hook = requireFile(snapshotRoot, "git/project/hooks/post-receive");
      if ((statSync(hook).mode & 0o111) === 0) throw new Error("multibranch post-receive hook is not executable");
      const text = readFileSync(hook, "utf8");
      if (!/refs\/heads\/(?:main|dev)|\bmain\b[\s\S]*\bdev\b/i.test(text)) throw new Error("hook does not visibly handle both main and dev branches");
      return "bare project and executable two-branch deployment hook are present";
    }
    case "multibranch-web-config": {
      const nginx = textCorpus(resolve(snapshotRoot, "nginx")); const ssh = textCorpus(resolve(snapshotRoot, "ssh"));
      if (!/listen\s+8443\b[\s\S]*ssl/i.test(nginx) || !/dev\/?/.test(nginx)) throw new Error("nginx HTTPS configuration does not expose main and dev endpoints on 8443");
      if (!/PasswordAuthentication\s+yes/i.test(ssh)) throw new Error("SSH password authentication is not enabled");
      return "public SSH and HTTPS multibranch configuration contract passed";
    }
    case "truncate-json-contract": {
      const rows = JSON.parse(readFileSync(requireFile(snapshotRoot, "app/recover.json"), "utf8"));
      if (!Array.isArray(rows) || rows.length === 0) throw new Error("recover.json must be a non-empty JSON array");
      const keys = new Set();
      for (const row of rows) {
        if (!row || typeof row.word !== "string" || !/^testword/.test(row.word) || typeof row.value !== "number" || !Number.isFinite(row.value)) throw new Error("recover.json row violates the public word/value contract");
        if (keys.has(row.word)) throw new Error("recover.json contains duplicate words"); keys.add(row.word);
      }
      return `recover.json contains ${rows.length} unique, well-formed rows`;
    }
    case "wal-json-contract": {
      const rows = JSON.parse(readFileSync(requireFile(snapshotRoot, "app/recovered.json"), "utf8"));
      if (!Array.isArray(rows) || rows.length !== 11) throw new Error("recovered.json must contain exactly 11 rows");
      rows.forEach((row, index) => { const id = index + 1; if (!row || row.id !== id || row.name !== `item${id}` || typeof row.value !== "number" || !Number.isFinite(row.value)) throw new Error(`recovered.json row ${id} violates the public sorted id/name/value contract`); });
      return "recovered.json contains all 11 sorted public-contract rows";
    }
    default: throw new Error(`Unregistered H1 check: ${checkId}`);
  }
}

class H1GateCommandExecutor {
  async execute(request) {
    const started = Date.now();
    if (request.command !== "h1-public-check" || request.args.length !== 1) return { exitCode: 2, signal: null, stdout: "", stderr: "Rejected undeclared H1 check command", durationMs: Date.now() - started, timedOut: false };
    try {
      const output = await evaluateCheck(request.args[0], request.cwd, request.timeoutMs);
      return { exitCode: 0, signal: null, stdout: String(output), stderr: "", durationMs: Date.now() - started, timedOut: false };
    } catch (error) {
      return { exitCode: 1, signal: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started, timedOut: false };
    }
  }
}

function completionGateFor(taskId) {
  const spec = TASK_SPECS[taskId];
  const parser = (check) => {
    const match = /^h1-public-check ([a-z0-9-]+)$/.exec(check.description);
    if (!match || !spec.checks.includes(match[1])) return { command: "", args: [], timeoutMs: 30_000 };
    return { command: "h1-public-check", args: [match[1]], timeoutMs: 30_000 };
  };
  return new CompletionGate(new H1GateCommandExecutor(), parser);
}

const gateInputFor = (taskId) => ({
  gateId: `H1_PUBLIC_CONTRACT_${taskId.toUpperCase().replaceAll("-", "_")}`,
  declaredChecks: TASK_SPECS[taskId].checks.map((id) => ({ id, description: `h1-public-check ${id}`, required: true })), evidenceRoot: "",
});

function loadCredentials() {
  const path = "/home/jordach/.config/shokunin-benchmarks/credentials.env";
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("="); if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim(), value = trimmed.slice(index + 1).trim();
    if (/^[A-Z][A-Z0-9_]*$/.test(key) && process.env[key] === undefined) process.env[key] = value;
  }
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) throw new Error(`Refusing to replace existing evidence file: ${path}`);
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(temp, path);
}

async function executeOne(trial) {
  loadCredentials();
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured for the frozen Codex runtime");
  const runtime = trial.runtime, publicTask = readPublicTaskConfig(trial.taskId), spec = TASK_SPECS[trial.taskId];
  const scratch = mkdtempSync("/tmp/shokunin-h1-executor-");
  try {
    const registriesPath = resolve(scratch, "registries.conf");
    writeFileSync(registriesPath, 'unqualified-search-registries = ["docker.io"]\n', "utf8");
    const hostEnv = { ...process.env, CONTAINERS_REGISTRIES_CONF: registriesPath, PATH: `${resolve(REPO_ROOT, "packages/benchmark-kit/bridge/podman-compat")}${delimiter}${process.env.PATH ?? ""}` };
    mkdirSync(RESULT_ROOT, { recursive: true }); const jobsRoot = resolve(RESULT_ROOT, "jobs"); mkdirSync(jobsRoot, { recursive: true });
    const token = trial.attestationNonce.slice(0, 12);
    const jobName = `${trial.taskId}-${trial.arm.toLowerCase().replaceAll("_", "-")}-r${trial.repetitionIndex}-${token}`;
    const jobConfigPath = resolve(RESULT_ROOT, "job-configs", `${jobName}.yaml`);
    atomicJson(jobConfigPath, {
      job_name: jobName, jobs_dir: jobsRoot, n_attempts: 1,
      timeout_multiplier: trial.arm === "A3_recovering" ? H1_A3_TIMEOUT_MULTIPLIER : 1,
      orchestrator: { type: "local", n_concurrent_trials: 1, quiet: true },
      environment: { type: "docker", force_build: false, delete: true }, tasks: [{ path: publicTask.taskDir }],
      agents: [{ name: "shokunin-intercept", import_path: "shokunin_intercept_agent:ShokuninInterceptAgent", model_name: runtime.model,
        kwargs: { shokunin_inner_agent: runtime.runtimeId, shokunin_arm: trial.arm, shokunin_expected_digest: runtime.containerDigests[trial.taskId], shokunin_export_paths: spec.exportPaths, shokunin_probe_kind: spec.probeKind ?? null, shokunin_verdict_timeout_sec: 120 } }],
    });
    const session = new HarborBridgeSession({ launch: { kind: "uv-wheel", requirementsLockPath: LOCK_PATH }, bridgeScriptPath: BRIDGE_PATH, wheelPath: WHEEL_PATH, env: hostEnv });
    const trialId = `${trial.campaignId}-${trial.taskId}-${trial.arm}-r${trial.repetitionIndex}-${token}`;
    const result = await executeVerticalSlice({
      trialId, arm: trial.arm, experimentId: trial.experimentId, campaignId: trial.campaignId, hypothesisId: "H1_COMPLETION_GATE", repetitionIndex: trial.repetitionIndex,
      runtimeId: runtime.runtimeId, runtimeVersion: runtime.runtimeVersion,
      task: { taskId: trial.taskId, taskName: trial.taskId, taskChecksum: computeTaskChecksum(publicTask.taskDir), benchmarkVersion: "2.1.0" },
      agent: { agentName: runtime.runtimeId, modelName: runtime.model, promptPath: publicTask.instructionPath },
      ...(trial.arm === "A0_baseline" ? {} : { gateInput: gateInputFor(trial.taskId), completionGate: completionGateFor(trial.taskId) }),
      expectedContainerDigest: runtime.containerDigests[trial.taskId],
      harborRequest: { jobConfigPath, jobsRoot, expectedJobName: jobName, timeoutMs: publicTask.timeoutMs, successCriterion: "reward >= 1.0", taskDirectory: publicTask.taskDir },
      ndjsonPath: resolve(RESULT_ROOT, "executor-trials.ndjson"), harborSession: session,
    });
    if (result.trials.length !== 1) throw new Error(`H1 executor expected one native trial, received ${result.trials.length}`);
    const validated = benchmarkTrialSchema.parse(result.trial);
    const executorHash = sha256File(EXECUTOR_PATH), wheelHash = sha256File(WHEEL_PATH), bridgeHash = sha256File(BRIDGE_PATH);
    const bridgeVersion = Object.entries(BRIDGE_ALLOWLIST).find(([, digest]) => digest === bridgeHash)?.[0];
    if (wheelHash !== OFFICIAL_HARBOR_WHEEL_SHA256 || !bridgeVersion) throw new Error("Loaded Harbor or bridge bytes are outside the laboratory allowlists");
    const receiptPath = resolve(RESULT_ROOT, "runtime-receipts", `${trialId}.json`);
    atomicJson(receiptPath, { nonce: trial.attestationNonce, pid: process.pid, executableIdentity: "shokunin-h1-host-executor", executablePath: "benchmarks/execution-zone/executors/h1-executor.mjs", executableSha256: executorHash, command: EXECUTOR_COMMAND, nodeVersion: process.version, taskImage: publicTask.image, taskContainerDigest: runtime.containerDigests[trial.taskId] });
    return { ...validated, runtimeAttestation: { nonce: trial.attestationNonce, receiptPath: relative(REPO_ROOT, receiptPath), receiptSha256: sha256File(receiptPath), wheelPath: relative(REPO_ROOT, WHEEL_PATH), wheelSha256: wheelHash, bridgePath: relative(REPO_ROOT, BRIDGE_PATH), bridgeSha256: bridgeHash, bridgeVersion } };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

async function main() {
  try { process.stdout.write(`${JSON.stringify(await executeOne(parseTrialArgument(process.argv.slice(2))))}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}

export { TASK_SPECS, evaluateCheck, gateInputFor, parseTrialArgument, readPublicTaskConfig };

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
