import { readFile, realpath, writeFile, rename, stat, lstat, mkdir, open, readdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { spawn, execFile } from "node:child_process";
import { EvalsEngine } from "@shokunin/evals";
import { OFFICIAL_HARBOR_WHEEL_SHA256, BRIDGE_ALLOWLIST, benchmarkTrialSchema } from "@shokunin/benchmark-kit";
type BcaBootstrapConfig = { readonly resamples: number; readonly seed: string; readonly confidenceLevel: number; readonly alternative: "two-sided" };
export interface PilotManifest { readonly status: string; readonly experimentId: string; readonly hypothesisId: string; readonly campaignId: string; readonly benchmark?: { readonly datasetRef?: string; readonly datasetPath?: string; readonly datasetDigest?: string | null }; readonly design: { readonly tasks: number; readonly arms: number; readonly repetitionsPerTaskArm: number; readonly plannedTrials: number }; readonly taskSelection: { readonly status?: string; readonly manifestPath: string; readonly manifestSha256: string | null; readonly officialTaskIds?: readonly string[] }; readonly runtimeQualification: { readonly status: string; readonly a3Eligible: boolean; readonly evidencePath?: string; readonly evidenceSha256?: string }; readonly runtime: { readonly runtimeId: string | null; readonly runtimeVersion: string | null; readonly model: string | null; readonly nodeVersion?: string; readonly harborWheelSha256?: string; readonly bridgeSha256?: string; readonly bridgeVersion?: string; readonly codeManifestPath?: string; readonly codeManifestSha256?: string; readonly containerDigests?: Readonly<Record<string, string>> }; }
export function assertPilotReady(manifest: PilotManifest): void {
  if (!manifest || typeof manifest !== "object") throw new Error("Invalid pilot manifest");
  if (manifest.experimentId !== "H1-completion-verification-001" || manifest.hypothesisId !== "H1_COMPLETION_GATE" || manifest.campaignId !== "H1-pilot-001") throw new Error("H1 identity is invalid");
  if (manifest.benchmark?.datasetRef !== "terminal-bench/terminal-bench-2-1@6" || typeof manifest.benchmark.datasetPath !== "string" || !/^[0-9a-f]{64}$/.test(manifest.benchmark.datasetDigest ?? "")) throw new Error("Canonical pinned Terminal-Bench dataset path and digest are required");
  if (manifest.design?.tasks !== 10 || manifest.design.arms !== 4 || manifest.design.repetitionsPerTaskArm !== 2 || manifest.design.plannedTrials !== 80) throw new Error("Pilot design must be exactly 10x4x2=80 trials");
  if (manifest.status !== "PREREGISTERED") throw new Error("Pilot manifest is not preregistered");
  if (!manifest.taskSelection || !/^[0-9a-f]{64}$/.test(manifest.taskSelection.manifestSha256 ?? "")) throw new Error("Immutable task manifest hash is required");
  if (manifest.taskSelection.status !== "FROZEN") throw new Error("H1 task selection must be frozen before launch");
  if (!Array.isArray(manifest.taskSelection.officialTaskIds) || manifest.taskSelection.officialTaskIds.length !== 10 || new Set(manifest.taskSelection.officialTaskIds).size !== 10 || manifest.taskSelection.officialTaskIds.some((id) => typeof id !== "string" || !id)) throw new Error("The frozen official task ID list is required");
  if (manifest.runtimeQualification?.status !== "PASS" || manifest.runtimeQualification.a3Eligible !== true) throw new Error("Runtime qualification for A3 is required");
  if (manifest.runtimeQualification.evidencePath !== "benchmarks/execution-zone/manifests/H1_RUNTIME_QUALIFICATION.json" || !/^[0-9a-f]{64}$/.test(manifest.runtimeQualification.evidenceSha256 ?? "")) throw new Error("Runtime qualification must be bound to the canonical hashed evidence manifest");
  if (!manifest.runtime?.runtimeId || !manifest.runtime.runtimeVersion || !manifest.runtime.model) throw new Error("Runtime and model freeze is required");
  if (!/^v\d+\.\d+\.\d+$/.test(manifest.runtime.nodeVersion ?? "")) throw new Error("Exact Node runtime version is required");
  if (manifest.runtime.codeManifestPath !== "benchmarks/execution-zone/manifests/H1_RUNTIME_CODE.json" || !/^[0-9a-f]{64}$/.test(manifest.runtime.codeManifestSha256 ?? "")) throw new Error("Runtime code must be bound to the canonical hashed code manifest");
  const frozenTaskIds = manifest.taskSelection.officialTaskIds ?? [];
  const digestEntries = Object.entries(manifest.runtime.containerDigests ?? {});
  if (digestEntries.length !== frozenTaskIds.length || frozenTaskIds.some((id) => !/^sha256:[0-9a-f]{64}$/.test(manifest.runtime.containerDigests?.[id] ?? "")) || digestEntries.some(([id]) => !frozenTaskIds.includes(id))) throw new Error("Every frozen task requires exactly one immutable container digest");
  if (manifest.runtime.harborWheelSha256?.toLowerCase() !== OFFICIAL_HARBOR_WHEEL_SHA256.toLowerCase()) throw new Error("Runtime Harbor wheel is not bound to the official authority");
  if (!manifest.runtime.bridgeSha256 || !Object.entries(BRIDGE_ALLOWLIST as Record<string, string>).some(([version, digest]) => version === manifest.runtime.bridgeVersion && digest.toLowerCase() === manifest.runtime.bridgeSha256!.toLowerCase())) throw new Error("Runtime bridge is not bound to the versioned allowlist");
}
export async function loadPilotManifest(path: string): Promise<PilotManifest> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid pilot manifest JSON");
  return parsed as PilotManifest;
}

export async function verifyManifestFile(path: string, expectedSha256: string): Promise<void> {
  const bytes = await readFile(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) throw new Error(`Manifest hash mismatch: expected ${expectedSha256}, got ${actual}`);
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
async function verifyMaterializedDataset(manifestPath: string): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { materializedRoot?: string; materializedBytesSha256?: string; materializedFileCount?: number; digestAlgorithm?: string; tasks?: Array<{ id?: string; digest?: string; files?: number }> };
  if (!manifest.materializedRoot || manifest.digestAlgorithm !== "sha256(JSON.stringify(sorted([repositoryRelativePath, sha256(fileBytes)])))" || !/^[0-9a-f]{64}$/.test(manifest.materializedBytesSha256 ?? "") || !Number.isInteger(manifest.materializedFileCount) || !Array.isArray(manifest.tasks)) throw new Error("Materialized dataset manifest is incomplete");
  const root = await resolveApprovedEvidenceFile(manifest.materializedRoot, ["benchmarks/execution-zone/datasets/"]);
  const rows: string[][] = [];
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const candidate = resolve(dir, name); const info = await lstat(candidate);
      if (info.isSymbolicLink()) throw new Error("Materialized dataset symlink is forbidden");
      if (info.isDirectory()) await walk(candidate); else rows.push([candidate.slice(root.length + 1), await sha256File(candidate)]);
    }
  }
  await walk(root);
  rows.sort(([left = ""], [right = ""]) => left.localeCompare(right));
  if (rows.length !== manifest.materializedFileCount) throw new Error("Materialized dataset file count mismatch");
  const aggregate = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  if (aggregate !== manifest.materializedBytesSha256!.toLowerCase()) throw new Error("Materialized dataset bytes digest mismatch");
  for (const task of manifest.tasks) {
    if (typeof task.id !== "string" || !/^[0-9a-f]{64}$/.test(task.digest ?? "") || !Number.isInteger(task.files)) throw new Error("Materialized task digest entry is incomplete");
    const taskId = task.id;
    const taskRows = rows.filter(([relativePath = ""]) => relativePath.startsWith(`${taskId}/`)).map(([relativePath = "", digest]) => [relativePath.slice(taskId.length + 1), digest]);
    if (taskRows.length !== task.files || createHash("sha256").update(JSON.stringify(taskRows)).digest("hex") !== task.digest!.toLowerCase()) throw new Error(`Materialized task digest mismatch: ${task.id}`);
  }
}
async function resolveRepoFile(path: string): Promise<string> {
  if (typeof path !== "string" || isAbsolute(path) || path !== path.normalize() || path.split(/[\\/]/).some((part) => part === ".")) throw new Error("Repository paths must be canonical relative paths");
  const root = resolve(process.cwd());
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Runtime attestation path must remain inside the repository");
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlink paths are forbidden for attested files");
  }
  return await realpath(candidate);
}

async function resolveApprovedEvidenceFile(path: string, roots: readonly string[]): Promise<string> {
  if (typeof path !== "string" || isAbsolute(path) || path.includes("..") || path !== path.normalize()) throw new Error("Evidence path must be a canonical repository-relative path");
  if (!roots.some((prefix) => path.startsWith(prefix))) throw new Error("Evidence path is outside its approved root");
  return await resolveRepoFile(path);
}

const APPROVED_RESULT_ROOTS = ["benchmarks/execution-zone/raw-results/", "benchmarks/execution-zone/normalized-results/"] as const;
const APPROVED_EXECUTOR_PROGRAMS = new Set(["node"]);
const H1_EXECUTOR_SCRIPT_SHA256 = "51146956249730129a0b5597cc9ebd5e8ec67db8c9444dae63413094d68b2259";
async function assertWritableEvidencePath(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Evidence output symlink is forbidden"); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
async function writeEvidenceNoFollow(path: string, contents: string): Promise<void> {
  const handle = await open(path, 0x20000 | 1 | 64 | 512, 0o600); // O_NOFOLLOW | O_WRONLY | O_CREAT | O_TRUNC
  try { await handle.writeFile(contents, "utf8"); } finally { await handle.close(); }
}
async function resolveApprovedResultPath(path: string): Promise<string> {
  if (typeof path !== "string" || !path) throw new Error("Result path is required");
  if (path !== path.normalize()) throw new Error("Result path must be lexically canonical");
  const root = resolve(process.cwd());
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (!APPROVED_RESULT_ROOTS.some((prefix) => rel.startsWith(prefix)) || isAbsolute(rel) || rel.includes(`${sep}..${sep}`) || rel.endsWith(`${sep}..`)) throw new Error("Result path must remain under an approved execution-zone results directory");
  const parent = resolve(candidate, "..");
  const actualParent = await realpath(parent);
  const parentRel = relative(root, actualParent);
  if (!APPROVED_RESULT_ROOTS.some((prefix) => `${parentRel}${sep}`.startsWith(prefix)) || isAbsolute(parentRel) || parentRel === ".." || parentRel.startsWith(`..${sep}`)) throw new Error("Result directory symlink escapes the approved boundary");
  // An existing output must also be checked: writeFile follows symlinks.
  try {
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Result file symlink is forbidden");
    const actualTarget = await realpath(candidate);
    const targetRel = relative(root, actualTarget);
    if (!APPROVED_RESULT_ROOTS.some((prefix) => targetRel.startsWith(prefix)) || isAbsolute(targetRel) || targetRel === ".." || targetRel.startsWith(`..${sep}`)) throw new Error("Result file symlink escapes the approved boundary");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return candidate;
}

async function gitOutput(args: readonly string[]): Promise<string> {
  return await new Promise((resolveOutput, reject) => execFile("git", [...args], { cwd: process.cwd(), encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolveOutput(stdout.trim())));
}
async function assertReviewedCommitIsPresent(commit: string): Promise<void> {
  try {
    await gitOutput(["cat-file", "-e", `${commit}^{commit}`]);
    await gitOutput(["merge-base", "--is-ancestor", commit, "HEAD"]);
  } catch { throw new Error("Seal reviewedCommit is not an ancestor of the current repository code"); }
}

async function resolveVerifiedTaskManifest(manifest: PilotManifest): Promise<{ path: string; tasks: Array<{ id: string; benchmark: string; version: string }> }> {
  const taskManifestPath = manifest.taskSelection.manifestPath;
  if (taskManifestPath !== "benchmarks/execution-zone/manifests/H1_TASK_SELECTION.json") throw new Error("Only the canonical frozen H1 task selection manifest is allowed");
  if (typeof taskManifestPath !== "string" || !taskManifestPath) throw new Error("Task manifest path is required");
  const root = resolve(process.cwd());
  const candidate = resolve(root, taskManifestPath);
  const rel = relative(root, candidate);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Task manifest path must remain inside the repository");
  const resolvedTaskPath = await resolveRepoFile(taskManifestPath);
  const resolvedRel = relative(root, resolvedTaskPath);
  if (isAbsolute(resolvedRel) || resolvedRel === ".." || resolvedRel.startsWith(`..${sep}`)) throw new Error("Task manifest symlink escapes the repository");
  await verifyManifestFile(resolvedTaskPath, manifest.taskSelection.manifestSha256!);
  const tasks: unknown = JSON.parse(await readFile(resolvedTaskPath, "utf8"));
  const ids = Array.isArray(tasks) ? tasks.map((task) => task && typeof task === "object" ? (task as { id?: unknown }).id : undefined) : [];
  if (!Array.isArray(tasks) || tasks.length !== 10 || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== 10 || tasks.some((task) => !task || typeof task !== "object" || (task as { benchmark?: unknown }).benchmark !== "terminal-bench" || (task as { version?: unknown }).version !== "2.1.0")) throw new Error("Task manifest must contain ten unique official Terminal-Bench 2.1.0 task IDs");
  if (ids.some((id) => !manifest.taskSelection.officialTaskIds!.includes(id as string))) throw new Error("Task manifest contains an ID outside the frozen official task list");
  return { path: resolvedTaskPath, tasks: tasks as Array<{ id: string; benchmark: string; version: string }> };
}

async function verifyRuntimeQualification(manifest: PilotManifest): Promise<void> {
  const path = await resolveApprovedEvidenceFile(manifest.runtimeQualification.evidencePath!, ["benchmarks/execution-zone/manifests/"]);
  if (await sha256File(path) !== manifest.runtimeQualification.evidenceSha256!.toLowerCase()) throw new Error("Runtime qualification manifest bytes do not match the frozen digest");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const qualification = parsed as {
    $schema?: unknown; status?: unknown; a3Eligible?: unknown; runtime?: Record<string, unknown>;
    capabilities?: unknown; evidence?: unknown;
  };
  if (!parsed || typeof parsed !== "object" || qualification.$schema !== "shokunin-h1-runtime-qualification/v1" || qualification.status !== "PASS" || qualification.a3Eligible !== true) throw new Error("Runtime qualification evidence is not a canonical PASS");
  const runtime = qualification.runtime;
  if (!runtime || runtime["runtimeId"] !== manifest.runtime.runtimeId || runtime["runtimeVersion"] !== manifest.runtime.runtimeVersion || runtime["model"] !== manifest.runtime.model || runtime["nativeStopSignal"] !== "clean-agent-return" || typeof runtime["claimExtractionMethod"] !== "string" || runtime["sessionResumeSupported"] !== true || runtime["structuredFeedbackSupported"] !== true || runtime["usageTelemetrySupported"] !== true || typeof runtime["trajectoryFormat"] !== "string" || runtime["adapterVersion"] !== manifest.runtime.bridgeVersion) throw new Error("Runtime qualification matrix does not match the frozen runtime or lacks A3 capabilities");
  const required = new Set(["stop-signal", "claim-extraction", "controlled-resume", "structured-feedback", "usage-telemetry", "trajectory-preservation"]);
  if (!Array.isArray(qualification.capabilities) || qualification.capabilities.length !== required.size) throw new Error("Runtime qualification capability set is incomplete");
  for (const item of qualification.capabilities as Array<Record<string, unknown>>) {
    if (typeof item?.["capability"] !== "string" || !required.delete(item["capability"] as string) || item["status"] !== "VERIFIED" || typeof item["evidenceId"] !== "string") throw new Error("Runtime qualification contains an unverified, duplicate, or unknown capability");
  }
  if (required.size !== 0 || !Array.isArray(qualification.evidence) || qualification.evidence.length === 0) throw new Error("Runtime qualification evidence references are incomplete");
  const evidenceIds = new Set<string>();
  for (const item of qualification.evidence as Array<Record<string, unknown>>) {
    if (typeof item?.["id"] !== "string" || evidenceIds.has(item["id"]) || typeof item["path"] !== "string" || !/^[0-9a-f]{64}$/.test(String(item["sha256"] ?? ""))) throw new Error("Runtime qualification evidence reference is malformed");
    evidenceIds.add(item["id"]);
    const evidencePath = await resolveApprovedEvidenceFile(item["path"] as string, ["benchmarks/execution-zone/raw-results/qualification/", "benchmarks/execution-zone/manifests/qualification/"]);
    if (await sha256File(evidencePath) !== String(item["sha256"]).toLowerCase()) throw new Error(`Runtime qualification evidence bytes mismatch: ${item["id"]}`);
  }
  for (const item of qualification.capabilities as Array<Record<string, unknown>>) if (!evidenceIds.has(item["evidenceId"] as string)) throw new Error(`Runtime capability cites unknown evidence: ${item["capability"]}`);
}

async function verifyRuntimeCodeManifest(manifest: PilotManifest): Promise<void> {
  const path = await resolveApprovedEvidenceFile(manifest.runtime.codeManifestPath!, ["benchmarks/execution-zone/manifests/"]);
  if (await sha256File(path) !== manifest.runtime.codeManifestSha256!.toLowerCase()) throw new Error("Runtime code manifest bytes do not match the frozen digest");
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const code = parsed as { $schema?: unknown; files?: unknown; aggregateSha256?: unknown };
  if (!parsed || typeof parsed !== "object" || code.$schema !== "shokunin-h1-runtime-code/v1" || !Array.isArray(code.files) || code.files.length === 0 || !/^[0-9a-f]{64}$/.test(String(code.aggregateSha256 ?? ""))) throw new Error("Runtime code manifest is malformed");
  const approvedRoots = ["packages/core/dist/", "packages/benchmark-kit/dist/", "packages/evals/dist/", "apps/benchmark-cli/dist/", "benchmarks/execution-zone/executors/"] as const;
  const rows: string[][] = [];
  const seen = new Set<string>();
  for (const item of code.files as Array<Record<string, unknown>>) {
    const itemPath = item?.["path"];
    const digest = item?.["sha256"];
    const bytes = item?.["bytes"];
    if (typeof itemPath !== "string" || seen.has(itemPath) || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest) || !Number.isInteger(bytes) || (bytes as number) < 0) throw new Error("Runtime code manifest entry is malformed or duplicated");
    seen.add(itemPath);
    const resolved = await resolveApprovedEvidenceFile(itemPath, approvedRoots);
    const info = await stat(resolved);
    if (!info.isFile() || info.size !== bytes || await sha256File(resolved) !== digest.toLowerCase()) throw new Error(`Runtime executable bytes mismatch: ${itemPath}`);
    rows.push([itemPath, digest.toLowerCase()]);
  }
  const requiredPaths = ["benchmarks/execution-zone/executors/h1-executor.mjs", "apps/benchmark-cli/dist/src/index.js", "packages/benchmark-kit/dist/src/index.js", "packages/core/dist/src/index.js", "packages/evals/dist/src/index.js"];
  if (requiredPaths.some((required) => !seen.has(required))) throw new Error("Runtime code manifest omits a required executable entrypoint");
  rows.sort(([left = ""], [right = ""]) => left.localeCompare(right));
  const aggregate = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  if (aggregate !== code.aggregateSha256) throw new Error("Runtime code aggregate digest is false");
}

export async function validatePilotManifest(path: string): Promise<PilotManifest> {
  const canonicalManifest = resolve(process.cwd(), "benchmarks/execution-zone/experiments/H1/experiment.json");
  if (path !== "benchmarks/execution-zone/experiments/H1/experiment.json") throw new Error("Only the canonical lexical H1 experiment manifest may authorize a pilot");
  if ((await realpath(path)) !== (await realpath(canonicalManifest))) throw new Error("Only the canonical H1 experiment manifest may authorize a pilot");
  await resolveRepoFile(path);
  const manifest = await loadPilotManifest(path);
  assertPilotReady(manifest);
  if (process.version !== manifest.runtime.nodeVersion) throw new Error(`Node runtime drift: expected ${manifest.runtime.nodeVersion}, got ${process.version}`);
  if (await gitOutput(["status", "--porcelain=v1", "--untracked-files=no"])) throw new Error("Pilot launch requires a clean tracked worktree");
  const root = resolve(process.cwd());
  await resolveVerifiedTaskManifest(manifest);
  await verifyRuntimeQualification(manifest);
  await verifyRuntimeCodeManifest(manifest);
  for (const seal of ["G3_EVAL_PIPELINE_STABLE.seal.json", "G4_PUBLIC_API_STABLE.seal.json"]) {
    const sealPath = await resolveApprovedEvidenceFile(`.shokunin/gates/${seal}`, [".shokunin/gates/"]);
    const sealData: unknown = JSON.parse(await readFile(sealPath, "utf8"));
    const expectedGate = seal.startsWith("G3") ? "G3_EVAL_PIPELINE_STABLE" : "G4_PUBLIC_API_STABLE";
    const sealObject = sealData as { verdict?: unknown; gateId?: unknown; reviewedCommit?: unknown; reviewArtifact?: unknown; reviewArtifactSha256?: unknown; bundlePath?: unknown; bundleSha256?: unknown };
    if (!sealData || typeof sealData !== "object" || sealObject.verdict !== "PASS" || sealObject.gateId !== expectedGate || !/^[0-9a-f]{40}$/.test(String(sealObject.reviewedCommit ?? "")) || typeof sealObject.reviewArtifact !== "string" || !/^[0-9a-f]{64}$/.test(String(sealObject.reviewArtifactSha256 ?? "")) || typeof sealObject.bundlePath !== "string" || !/^[0-9a-f]{64}$/.test(String(sealObject.bundleSha256 ?? ""))) throw new Error(`${seal} is not an identity-bound PASS seal`);
    await assertReviewedCommitIsPresent(String(sealObject.reviewedCommit));
    try {
      const artifactPath = await resolveApprovedEvidenceFile(sealObject.reviewArtifact, [".shokunin/gates/", "benchmarks/execution-zone/manifests/"]); const artifactStat = await stat(artifactPath); if (!artifactStat.isFile()) throw new Error("not a file");
      if (await sha256File(artifactPath) !== String(sealObject.reviewArtifactSha256)) throw new Error("review artifact hash mismatch");
      const bundlePath = await resolveApprovedEvidenceFile(sealObject.bundlePath, [".shokunin/gates/", "benchmarks/execution-zone/manifests/bundle/"]); const bundleStat = await stat(bundlePath); if (!bundleStat.isFile()) throw new Error("bundle is not a file");
      if (await sha256File(bundlePath) !== String(sealObject.bundleSha256)) throw new Error("bundle hash mismatch");
    } catch { throw new Error(`${seal} review artifact or bundle is missing, escaped, or has invalid bytes`); }
  }
  const datasetPath = await resolveApprovedEvidenceFile(manifest.benchmark!.datasetPath!, ["benchmarks/execution-zone/manifests/"]);
  if (await sha256File(datasetPath) !== manifest.benchmark!.datasetDigest!.toLowerCase()) throw new Error("Terminal-Bench dataset bytes do not match the registered digest");
  await verifyMaterializedDataset(datasetPath);
  return manifest;
}

export async function evaluateTrials(trialsPath: string, outputPath: string, config: BcaBootstrapConfig): Promise<void> {
  await mkdir(resolve(process.cwd(), "benchmarks/execution-zone/raw-results"), { recursive: true });
  await mkdir(resolve(process.cwd(), "benchmarks/execution-zone/normalized-results"), { recursive: true });
  const safeTrialsPath = await resolveApprovedResultPath(trialsPath);
  const safeOutputPath = await resolveApprovedResultPath(outputPath);
  const trials = JSON.parse(await readFile(safeTrialsPath, "utf8"));
  if (!Array.isArray(trials)) throw new Error("Trials input must be an array");
  const report = await new EvalsEngine().computeReport(trials, config);
  const serializable = { ...report, pairedComparisons: [...report.pairedComparisons.entries()], sensitivityAnalysis: [...report.sensitivityAnalysis.entries()], intentionToTreat: report.intentionToTreat.map((item) => ({ ...item, attritionByReason: [...item.attritionByReason.entries()] })), metadata: { experimentId: "H1-completion-verification-001", hypothesisId: "H1_COMPLETION_GATE", benchmark: "terminal-bench", benchmarkVersion: "2.1.0", target: "Deterministic completion verification and bounded recovery: reduce terminal false-completion while preserving native verifier success.", targetPainPoints: ["5 Definition of Done", "6 Testing", "7 Evals", "16 Auditability"], arms: ["A0_baseline", "A1_observing", "A2_blocking", "A3_recovering"], plannedDesign: "10 tasks × 4 arms × 2 repetitions = 80 trials", estimandStatus: "PILOT_APPARATUS_ONLY — not an effectiveness claim", oracle: "native Harbor task verifier" } };
  await writeFile(safeOutputPath, JSON.stringify(serializable, null, 2) + "\n", "utf8");
}

async function runExecutor(command: string, trial: Record<string, unknown>): Promise<{ readonly stdout: string; readonly pid: number }> {
  const [program, ...fixedArgs] = command.trim().split(/\s+/);
  if (!program) throw new Error("SHOKUNIN_H1_EXECUTOR is empty");
  if (!APPROVED_EXECUTOR_PROGRAMS.has(program)) throw new Error("H1 executor command is not on the explicit allowlist");
  const scriptArgument = fixedArgs[0];
  if (fixedArgs.length !== 1 || typeof scriptArgument !== "string" || scriptArgument !== "benchmarks/execution-zone/executors/h1-executor.mjs") throw new Error("H1 executor must be exactly node benchmarks/execution-zone/executors/h1-executor.mjs");
  return await new Promise((resolveOutput, reject) => {
    const child = spawn(program, [...fixedArgs, "--trial-json", JSON.stringify(trial)], { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("H1 executor timed out after 30 minutes")); }, 30 * 60 * 1000);
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => { clearTimeout(timeout); code === 0 ? resolveOutput({ stdout, pid: child.pid ?? -1 }) : reject(new Error(`H1 executor failed (${code}): ${stderr.slice(-1000)}`)); });
  });
}

export async function runPilot(manifestPath: string, outputPath: string): Promise<void> {
  await mkdir(resolve(process.cwd(), "benchmarks/execution-zone/raw-results"), { recursive: true });
  await mkdir(resolve(process.cwd(), "benchmarks/execution-zone/normalized-results"), { recursive: true });
  const safeOutputPath = await resolveApprovedResultPath(outputPath);
  const manifest = await validatePilotManifest(manifestPath);
  const executor = process.env["SHOKUNIN_H1_EXECUTOR"];
  if (!executor) throw new Error("H1 execution is fail-closed: set SHOKUNIN_H1_EXECUTOR to the reviewed executor command");
  const verified = await resolveVerifiedTaskManifest(manifest);
  const tasks = verified.tasks;
  const arms = ["A0_baseline", "A1_observing", "A2_blocking", "A3_recovering"];
  const results: Array<Record<string, unknown>> = [];
  const trialIds = new Set<string>();
  for (const task of tasks) for (const arm of arms) for (let repetitionIndex = 0; repetitionIndex < manifest.design.repetitionsPerTaskArm; repetitionIndex += 1) {
    const attestationNonce = randomBytes(32).toString("hex");
    const trial = { campaignId: manifest.campaignId, experimentId: manifest.experimentId, taskId: task.id, arm, repetitionIndex, runtime: manifest.runtime, attestationNonce };
    const execution = await runExecutor(executor, trial);
    const stdout = execution.stdout;
    let executed: unknown;
    try { executed = JSON.parse(stdout); } catch { throw new Error(`H1 executor returned non-JSON output for ${task.id}/${arm}/${repetitionIndex}`); }
    if (!executed || typeof executed !== "object") throw new Error(`H1 executor returned an invalid trial for ${task.id}/${arm}/${repetitionIndex}`);
    const attestation = (executed as { runtimeAttestation?: { nonce?: unknown; receiptPath?: unknown; receiptSha256?: unknown; wheelPath?: unknown; wheelSha256?: unknown; bridgePath?: unknown; bridgeSha256?: unknown; bridgeVersion?: unknown } }).runtimeAttestation;
    if (!attestation || attestation.nonce !== attestationNonce || typeof attestation.receiptPath !== "string" || typeof attestation.receiptSha256 !== "string" || typeof attestation.wheelPath !== "string" || typeof attestation.wheelSha256 !== "string" || typeof attestation.bridgePath !== "string" || typeof attestation.bridgeSha256 !== "string" || typeof attestation.bridgeVersion !== "string") throw new Error(`H1 executor omitted nonce-bound runtime receipt for ${task.id}/${arm}/${repetitionIndex}`);
    const receiptPath = await resolveApprovedEvidenceFile(attestation.receiptPath, ["benchmarks/execution-zone/raw-results/"]);
    if (await sha256File(receiptPath) !== attestation.receiptSha256.toLowerCase()) throw new Error("Runtime receipt bytes do not match the attested digest");
    const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
    const receiptObject = receipt as { nonce?: unknown; pid?: unknown; executableIdentity?: unknown; executablePath?: unknown; executableSha256?: unknown; command?: unknown; nodeVersion?: unknown; taskContainerDigest?: unknown };
    if (!receipt || typeof receipt !== "object" || receiptObject.nonce !== attestationNonce || receiptObject.pid !== execution.pid || typeof receiptObject.executableIdentity !== "string" || !receiptObject.executableIdentity || receiptObject.command !== executor || typeof receiptObject.executablePath !== "string" || typeof receiptObject.executableSha256 !== "string" || !/^[0-9a-f]{64}$/.test(receiptObject.executableSha256)) throw new Error("Runtime receipt is not bound to this nonce, child PID, executable identity, and allowlisted command");
    if (receiptObject.executablePath !== "benchmarks/execution-zone/executors/h1-executor.mjs") throw new Error("Runtime executable identity does not equal the allowlisted script");
    if (receiptObject.nodeVersion !== manifest.runtime.nodeVersion || receiptObject.taskContainerDigest !== manifest.runtime.containerDigests?.[task.id]) throw new Error("Runtime receipt contradicts the frozen Node or container identity");
    const executablePath = await resolveRepoFile(receiptObject.executablePath);
    if (await sha256File(executablePath) !== receiptObject.executableSha256.toLowerCase() || receiptObject.executableSha256.toLowerCase() !== H1_EXECUTOR_SCRIPT_SHA256) throw new Error("Runtime executable identity digest is false or unallowlisted");
    const wheelDigest = (await sha256File(await resolveRepoFile(attestation.wheelPath))).toLowerCase();
    if (attestation.wheelSha256.toLowerCase() !== wheelDigest || wheelDigest !== OFFICIAL_HARBOR_WHEEL_SHA256.toLowerCase()) throw new Error("H1 loaded Harbor wheel bytes do not match the official authority");
    const bridgeDigest = (await sha256File(await resolveRepoFile(attestation.bridgePath))).toLowerCase();
    if (attestation.bridgeSha256.toLowerCase() !== bridgeDigest || (BRIDGE_ALLOWLIST as Record<string, string>)[attestation.bridgeVersion]?.toLowerCase() !== bridgeDigest) throw new Error("H1 loaded bridge bytes do not match the versioned allowlist");
    const validated = benchmarkTrialSchema.parse(executed);
    if (validated.distribution !== "wheel-verified") throw new Error(`H1 executor did not provide wheel-verified runtime evidence for ${task.id}/${arm}/${repetitionIndex}`);
    if (validated.experimentId !== manifest.experimentId || validated.hypothesisId !== manifest.hypothesisId || validated.campaignId !== manifest.campaignId || validated.arm !== arm || validated.repetitionIndex !== repetitionIndex || validated.task.id !== task.id) {
      throw new Error(`H1 executor returned mismatched trial identity for ${task.id}/${arm}/${repetitionIndex}`);
    }
    if (trialIds.has(validated.trialId)) throw new Error(`H1 executor returned duplicate trialId ${validated.trialId}`);
    trialIds.add(validated.trialId);
    results.push(validated as Record<string, unknown>);
    const progressPath = `${safeOutputPath}.progress`;
    await assertWritableEvidencePath(progressPath);
    await writeEvidenceNoFollow(progressPath, JSON.stringify(results, null, 2) + "\n");
  }
  if (results.length !== manifest.design.plannedTrials) throw new Error(`Executor produced ${results.length} trials; expected ${manifest.design.plannedTrials}`);
  const temporaryOutput = `${safeOutputPath}.tmp-${process.pid}`;
  await assertWritableEvidencePath(temporaryOutput);
  await writeEvidenceNoFollow(temporaryOutput, JSON.stringify(results, null, 2) + "\n");
  await rename(temporaryOutput, safeOutputPath);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    if (argv[0] === "pilot" && argv[1] === "validate" && argv[2]) { await validatePilotManifest(argv[2]); console.log("Pilot prerequisites valid."); return 0; }
    if (argv[0] === "pilot" && argv[1] === "run" && argv[2] && argv[3]) { await runPilot(argv[2], argv[3]); console.log(`H1 pilot results written to ${argv[3]}`); return 0; }
    if (argv[0] === "evaluate" && argv[1] && argv[2]) { await evaluateTrials(argv[1], argv[2], { resamples: 10000, seed: "H1-pilot-001-seed-v1", confidenceLevel: 0.95, alternative: "two-sided" }); console.log(`Evaluation report written to ${argv[2]}`); return 0; }
    console.error("Usage: shokunin-benchmark pilot validate <manifest> | pilot run <manifest> <trials.json> | evaluate <trials.json> <report.json>"); return 2;
  } catch (error: unknown) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}

if (process.argv[1]?.endsWith("index.js")) main().then((code) => { process.exitCode = code; });
