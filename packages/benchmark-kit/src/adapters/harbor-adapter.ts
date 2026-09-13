import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  LocalCommandExecutor,
  type ICommandExecutor,
} from "@shokunin/core";
import type {
  HarborJobRequest,
  HarborJobResult,
  HarborTrialReference,
  IHarborRunner,
} from "../../contracts/harbor.contract.js";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";
import { parseHarborJobYaml } from "./yaml-parser.js";
import {
  harborJobConfigSchema,
  harborJobResultSchema,
  harborTrialResultSchema,
} from "../../schemas/harbor.schema.js";
import { computeTaskChecksum } from "../crypto/dirhash.js";
import {
  PINNED_HARBOR_VERSION,
  type HarborDistributionAttestation,
  type HarborDistributionIdentity,
} from "./harbor-distribution-allowlist.js";
import {
  resolveExecutableAbs,
  sha256OfExecutable,
} from "./docker-digest-resolver.js";
import { assertTrialUriExact } from "./trial-uri.js";
import { isProvenGateBlock } from "./sidecars.js";

function readJsonIfExists(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { __unparseable: true, file: path };
  }
}

export interface PreflightOptions {
  readonly checkHarbor?: boolean;
  readonly checkContainerRuntime?: boolean;
  readonly preferredRuntime?: "docker" | "podman";
}

export interface PreflightStatus {
  readonly harborAvailable: boolean;
  readonly harborVersion?: string | undefined;
  readonly containerRuntime: "docker" | "podman" | null;
  readonly containerRuntimeVersion?: string | undefined;
  /**
   * R5: public preflight never verifies a pinned hash (no executor-chosen
   * hash is accepted anywhere). Binary-pinned verification happens only
   * inside run()/executeSession() against the manifest-derived
   * `HarborJobRequest.expectedHarborBinarySha256`.
   */
  readonly harborIdentity: HarborDistributionIdentity;
  readonly harborBinarySha256?: string | undefined;
  readonly versionSource?: "importlib" | "help-text" | "unresolved" | undefined;
}

export interface HarborAdapterOptions {
  readonly executor?: ICommandExecutor | undefined;
  readonly harborExecutable?: string | undefined;
  readonly harborPrefixArgs?: readonly string[] | undefined;
  readonly containerRuntime?: "docker" | "podman" | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export function evaluateSuccessCriterion(
  rewards: Readonly<Record<string, number>>,
  criterion: string,
): boolean {
  const trimmed = criterion.trim();
  // Strict numeric regex: standard integer or float (e.g. 1, 1.0, 0.25, -5). Rejects 1..0, 1., .5, etc.
  const match = trimmed.match(/^([a-zA-Z0-9_-]+)\s*(>=|<=|>|<|==|!=|=)\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?)$/);
  if (!match) {
    // Detect invalid operators or malformed numbers (like double dots, dangling dots)
    if (/[><=~!]|(?:\.\.)/.test(trimmed)) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: 'Invalid successCriterion format or malformed numeric literal: "' + criterion + '"',
        remediation: "Specify criterion in format 'key >= value' or 'key == value' with a valid numeric literal (e.g. 'reward >= 1.0').",
        retryable: false,
      });
    }

    if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      const val = rewards[trimmed];
      if (val === undefined || Number.isNaN(val)) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Reward key "' + trimmed + '" missing or NaN in verifier_result.rewards',
          remediation: "Ensure the task verifier emits the expected reward key in its output dictionary.",
          retryable: false,
          details: { rewards, criterion },
        });
      }
      return val > 0;
    }

    throw new ActionableBenchmarkError({
      code: "CONFIG_INVALID",
      message: 'Invalid successCriterion format: "' + criterion + '"',
      remediation: "Specify criterion in format 'key >= value' or 'key == value'.",
      retryable: false,
    });
  }

  const key = match[1]!;
  const op = match[2]!;
  const rawNum = match[3]!;

  const val = rewards[key];
  if (val === undefined || Number.isNaN(val)) {
    throw new ActionableBenchmarkError({
      code: "RESULT_INVALID",
      message: 'Required reward key "' + key + '" missing from verifier_result.rewards',
      remediation: 'Ensure verifier script outputs a dictionary containing "' + key + '".',
      retryable: false,
      details: { rewards, expectedKey: key },
    });
  }

  const target = parseFloat(rawNum);
  switch (op) {
    case ">=":
      return val >= target;
    case "<=":
      return val <= target;
    case ">":
      return val > target;
    case "<":
      return val < target;
    case "==":
    case "=":
      return Math.abs(val - target) < 1e-9;
    case "!=":
      return Math.abs(val - target) >= 1e-9;
    default:
      return false;
  }
}

export class HarborAdapter implements IHarborRunner {
  private readonly executor: ICommandExecutor;
  private readonly harborExecutable: string;
  private readonly harborPrefixArgs: readonly string[];
  private readonly containerRuntime?: "docker" | "podman" | undefined;
  private readonly env?: Readonly<Record<string, string>> | undefined;

  constructor(options: HarborAdapterOptions = {}) {
    this.executor = options.executor ?? new LocalCommandExecutor();
    this.harborExecutable = options.harborExecutable ?? "harbor";
    this.harborPrefixArgs = options.harborPrefixArgs ?? [];
    this.containerRuntime = options.containerRuntime;
    this.env = options.env;
  }

  /** Absolute launcher path resolved with the EXECUTION env PATH (R4 used process PATH). */
  private resolveLauncherAbs(): string | null {
    return resolveExecutableAbs(this.harborExecutable, this.env);
  }

  private execCommand(): string {
    return this.resolveLauncherAbs() ?? this.harborExecutable;
  }

  private async execHarbor(
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    return this.executor.execute({
      command: this.execCommand(),
      args: [...this.harborPrefixArgs, ...args],
      cwd: process.cwd(),
      ...(this.env ? { env: this.env } : {}),
      timeoutMs,
    });
  }

  /**
   * Genuine Harbor 0.1.2 Typer CLI shape, calibrated against the OFFICIAL
   * distribution (`uv run ... python3 -m harbor.cli.sb.main --help`):
   * `Usage:` header, a `Commands` section WITHOUT colon (R4 wrongly required
   * `Commands:`, which rejects the real CLI), and all of
   * jobs/tasks/trials/run/sweeps. Text shape alone never authenticates a
   * binary (see manifest-pinned verification in run()).
   */
  private assertGenuineCliShape(helpStdout: string): void {
    const hasUsage = /\busage\s*:/i.test(helpStdout);
    const hasCommandsSection = /\bcommands\b/i.test(helpStdout);
    const mandatorySubcommands = ["jobs", "tasks", "trials", "run", "sweeps"];
    const missingSubcommands = mandatorySubcommands.filter(
      (cmd) => !new RegExp(`\\b${cmd}\\b`, "i").test(helpStdout),
    );
    const lowered = (helpStdout || "").toLowerCase();
    if (
      !lowered ||
      lowered.includes("forged") ||
      lowered.includes("fake") ||
      lowered.includes("not-the-official-harbor") ||
      !lowered.includes("harbor") ||
      !hasUsage ||
      !hasCommandsSection ||
      missingSubcommands.length > 0
    ) {
      throw new ActionableBenchmarkError({
        code: "HARNESS_UNAVAILABLE",
        message:
          "Harbor executable did not respond with genuine Harbor CLI (missing genuine Harbor Typer CLI structure: " +
          (missingSubcommands.length > 0 ? missingSubcommands.join(", ") : "forged executable banner") +
          ").",
        remediation: "Ensure the specified executable is the official Harbor benchmark harness distribution.",
        retryable: false,
        details: { stdout: helpStdout },
      });
    }
  }

  /**
   * Authoritative version query. The real 0.1.2 CLI prints NO version in
   * `--help` and has NO `--version` flag, so the version is read from
   * importlib metadata through the same launcher prefix when it ends with
   * `python3 -m <module>` (e.g. the uv-launched wire-test double, which IS
   * the official wheel). Plain launchers fall back to help-text extraction;
   * unobtainable versions stay undefined (test-double mode).
   */
  private async queryHarborVersion(): Promise<{ version: string | undefined; source: "importlib" | "help-text" | "unresolved" }> {
    const tail = this.harborPrefixArgs.slice(-3);
    if (tail.length === 3 && tail[0] === "python3" && tail[1] === "-m" && typeof tail[2] === "string") {
      const res = await this.executor.execute({
        command: this.execCommand(),
        args: [
          ...this.harborPrefixArgs.slice(0, -3),
          "python3",
          "-c",
          "import importlib.metadata as m; print(m.version('harbor'))",
        ],
        cwd: process.cwd(),
        ...(this.env ? { env: this.env } : {}),
        timeoutMs: 30000,
      });
      if (res.timedOut || res.exitCode !== 0) {
        throw new ActionableBenchmarkError({
          code: "HARNESS_UNAVAILABLE",
          message: "Harbor distribution version query failed (importlib metadata unreachable).",
          remediation: "Ensure the launcher environment has the official Harbor 0.1.2 distribution installed.",
          retryable: false,
          details: { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode },
        });
      }
      const m = res.stdout.match(/(\d+\.\d+\.\d+)/);
      return { version: m ? m[1]! : undefined, source: "importlib" };
    }
    return { version: undefined, source: "unresolved" };
  }

  private async probeContainerRuntime(
    preferred?: "docker" | "podman",
  ): Promise<{ runtime: "docker" | "podman"; version: string | undefined }> {
    const candidates: ("docker" | "podman")[] = preferred ? [preferred] : ["docker", "podman"];
    for (const candidate of candidates) {
      try {
        const res = await this.executor.execute({
          command: candidate,
          args: ["info"],
          cwd: process.cwd(),
          ...(this.env ? { env: this.env } : {}),
          timeoutMs: 10000,
        });
        if (!res.timedOut && res.exitCode === 0) {
          return { runtime: candidate, version: res.stdout.trim().split(/\r?\n/)[0] };
        }
      } catch {
        // try next candidate
      }
    }
    throw new ActionableBenchmarkError({
      code: "INFRASTRUCTURE_FAILURE",
      message: "No responsive container engine found (checked: " + candidates.join(", ") + ").",
      remediation: "Ensure Docker daemon or Podman service is running and accessible to the current user without sudo.",
      retryable: false,
    });
  }

  /**
   * Mandatory preflight gate executed at the start of EVERY run() (R5 item 8,
   * kept in R6). Binary trust is NOT established here: no caller-supplied
   * hash is accepted anywhere (R6 deletes the self-attestation path); the
   * laboratory allowlist (wheel) is consulted by the bridge session only.
   * The resolved launcher hash is recorded for telemetry.
   */
  private async mandatoryPreflight(): Promise<{
    harborVersion: string | undefined;
    versionSource: "importlib" | "help-text" | "unresolved";
    containerRuntime: "docker" | "podman";
    containerRuntimeVersion: string | undefined;
    launcherAbs: string | null;
    launcherHashAtPreflight: string | null;
  }> {
    const helpRes = await this.execHarbor(["--help"], 10000);
    if (helpRes.timedOut) {
      throw new ActionableBenchmarkError({
        code: "HARNESS_UNAVAILABLE",
        message: "Harbor preflight check timed out after 10000ms",
        remediation: "Verify harbor executable is responsive and not hanging.",
        retryable: false,
      });
    }
    if (helpRes.exitCode !== 0) {
      throw new ActionableBenchmarkError({
        code: "HARNESS_UNAVAILABLE",
        message: "Harbor preflight failed with exit code " + helpRes.exitCode + ": " + (helpRes.stderr || helpRes.stdout).trim(),
        remediation: "Ensure harbor CLI is installed and configured in PATH or harborExecutable option.",
        retryable: false,
        details: { exitCode: helpRes.exitCode, stdout: helpRes.stdout, stderr: helpRes.stderr },
      });
    }
    this.assertGenuineCliShape(helpRes.stdout);

    const runProbeRes = await this.execHarbor(["run", "--help"], 10000);
    if (
      runProbeRes.exitCode !== 0 ||
      !runProbeRes.stdout.includes("-c") ||
      !runProbeRes.stdout.toLowerCase().includes("config")
    ) {
      throw new ActionableBenchmarkError({
        code: "HARNESS_UNAVAILABLE",
        message: 'Harbor executable failed authentication probe for official "run" subcommand flags (-c/--config).',
        remediation: "Ensure the executable is the authentic Harbor CLI 0.1.2 distribution.",
        retryable: false,
        details: { stdout: runProbeRes.stdout, stderr: runProbeRes.stderr },
      });
    }

    // Version corroboration (may stay unresolved for shape-only doubles).
    let harborVersion: string | undefined;
    let versionSource: "importlib" | "help-text" | "unresolved" = "unresolved";
    const helpVersion = helpRes.stdout.match(/\b(?:version\s+|v)([0-9]+\.[0-9]+\.[0-9]+)/i);
    if (helpVersion?.[1]) {
      harborVersion = helpVersion[1];
      versionSource = "help-text";
    } else {
      const queried = await this.queryHarborVersion();
      harborVersion = queried.version;
      versionSource = queried.source;
    }
    if (harborVersion !== undefined && harborVersion !== PINNED_HARBOR_VERSION) {
      throw new ActionableBenchmarkError({
        code: "HARNESS_UNAVAILABLE",
        message: `Harbor version mismatch: expected official pinned version "${PINNED_HARBOR_VERSION}", got "${harborVersion}".`,
        remediation: `Install and configure the official Harbor harness pinned at version ${PINNED_HARBOR_VERSION}.`,
        retryable: false,
        details: { expectedVersion: PINNED_HARBOR_VERSION, detectedVersion: harborVersion },
      });
    }

    const container = await this.probeContainerRuntime(this.containerRuntime);

    // TOCTOU best-effort: hash the resolved launcher now; run() re-hashes
    // immediately before exec and rejects replacement in between.
    const launcherAbs = this.resolveLauncherAbs();
    const launcherHashAtPreflight = launcherAbs ? sha256OfExecutable(launcherAbs) : null;

    return {
      harborVersion,
      versionSource,
      containerRuntime: container.runtime,
      containerRuntimeVersion: container.version,
      launcherAbs,
      launcherHashAtPreflight,
    };
  }

  async preflight(options: PreflightOptions = {}): Promise<PreflightStatus> {
    const checkHarbor = options.checkHarbor ?? true;
    const checkContainer = options.checkContainerRuntime ?? true;
    let harborVersion: string | undefined;
    let versionSource: "importlib" | "help-text" | "unresolved" = "unresolved";
    let detectedRuntime: "docker" | "podman" | null = null;
    let runtimeVersion: string | undefined;
    let launcherHash: string | null = null;

    if (checkHarbor) {
      // Public preflight performs shape + version corroboration only. It
      // NEVER verifies a pinned hash (no executor-chosen hash accepted).
      const helpRes = await this.execHarbor(["--help"], 10000);
      if (helpRes.timedOut) {
        throw new ActionableBenchmarkError({
          code: "HARNESS_UNAVAILABLE",
          message: "Harbor preflight check timed out after 10000ms",
          remediation: "Verify harbor executable is responsive and not hanging.",
          retryable: false,
        });
      }
      if (helpRes.exitCode !== 0) {
        throw new ActionableBenchmarkError({
          code: "HARNESS_UNAVAILABLE",
          message: "Harbor preflight failed with exit code " + helpRes.exitCode + ": " + (helpRes.stderr || helpRes.stdout).trim(),
          remediation: "Ensure harbor CLI is installed and configured in PATH or harborExecutable option.",
          retryable: false,
          details: { exitCode: helpRes.exitCode, stdout: helpRes.stdout, stderr: helpRes.stderr },
        });
      }
      this.assertGenuineCliShape(helpRes.stdout);

      const runProbeRes = await this.execHarbor(["run", "--help"], 10000);
      if (
        runProbeRes.exitCode !== 0 ||
        !runProbeRes.stdout.includes("-c") ||
        !runProbeRes.stdout.toLowerCase().includes("config")
      ) {
        throw new ActionableBenchmarkError({
          code: "HARNESS_UNAVAILABLE",
          message: 'Harbor executable failed authentication probe for official "run" subcommand flags (-c/--config).',
          remediation: "Ensure the executable is the authentic Harbor CLI 0.1.2 distribution.",
          retryable: false,
          details: { stdout: runProbeRes.stdout, stderr: runProbeRes.stderr },
        });
      }

      const helpVersion = helpRes.stdout.match(/\b(?:version\s+|v)([0-9]+\.[0-9]+\.[0-9]+)/i);
      if (helpVersion?.[1]) {
        harborVersion = helpVersion[1];
        versionSource = "help-text";
      } else {
        const queried = await this.queryHarborVersion();
        harborVersion = queried.version;
        versionSource = queried.source;
      }
      if (harborVersion !== undefined && harborVersion !== PINNED_HARBOR_VERSION) {
        throw new ActionableBenchmarkError({
          code: "HARNESS_UNAVAILABLE",
          message: `Harbor version mismatch: expected official pinned version "${PINNED_HARBOR_VERSION}", got "${harborVersion}".`,
          remediation: `Install and configure the official Harbor harness pinned at version ${PINNED_HARBOR_VERSION}.`,
          retryable: false,
          details: { expectedVersion: PINNED_HARBOR_VERSION, detectedVersion: harborVersion },
        });
      }

      const launcherAbs = this.resolveLauncherAbs();
      launcherHash = launcherAbs ? sha256OfExecutable(launcherAbs) : null;
    }

    if (checkContainer) {
      const probed = await this.probeContainerRuntime(options.preferredRuntime ?? this.containerRuntime);
      detectedRuntime = probed.runtime;
      runtimeVersion = probed.version;
    }

    return {
      harborAvailable: true,
      harborVersion,
      containerRuntime: detectedRuntime,
      containerRuntimeVersion: runtimeVersion,
      harborIdentity: "cli-shape-only",
      harborBinarySha256: launcherHash ?? undefined,
      versionSource,
    };
  }

  private lastRunContainerRuntime: "docker" | "podman" = "docker";

  async run(
    request: HarborJobRequest,
    options: { allowExpectedGateBlocked?: boolean } = {},
  ): Promise<HarborJobResult> {
    // 0. Synchronous request validation inline below FIRST (fail-fast, no
    // executor interaction): malformed requests are CONFIG_INVALID regardless
    // of harness availability. The mandatory preflight gate follows it.
    if (!request.jobConfigPath || typeof request.jobConfigPath !== "string") {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: "HarborJobRequest.jobConfigPath must be a non-empty string path.",
        remediation: "Provide a valid path to job-config.yaml or config.json.",
        retryable: false,
      });
    }

    if (!existsSync(request.jobConfigPath)) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: 'Manifest file not found: "' + request.jobConfigPath + '"',
        remediation: "Verify the path to the job configuration manifest.",
        retryable: false,
      });
    }

    if (!request.jobsRoot || typeof request.jobsRoot !== "string" || !existsSync(request.jobsRoot)) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: 'jobsRoot directory not found: "' + request.jobsRoot + '"',
        remediation: "Ensure jobsRoot directory exists before running HarborAdapter.",
        retryable: false,
      });
    }

    if (!request.expectedJobName || typeof request.expectedJobName !== "string") {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: "HarborJobRequest.expectedJobName must be a non-empty string.",
        remediation: "Specify the expected job directory name.",
        retryable: false,
      });
    }

    // Path confinement: reject null bytes, traversal, absolute paths, and escapes
    if (
      isAbsolute(request.expectedJobName) ||
      request.expectedJobName.includes("..") ||
      request.expectedJobName.includes("\0")
    ) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: 'Path escape detected: expectedJobName "' + request.expectedJobName + '" attempts directory traversal or absolute escape.',
        remediation: "Specify a simple relative directory name contained strictly within jobsRoot.",
        retryable: false,
      });
    }

    const realJobsRoot = realpathSync(request.jobsRoot);
    const targetJobDir = resolve(realJobsRoot, request.expectedJobName);
    const rel = relative(realJobsRoot, targetJobDir);
    if (rel.startsWith("..") || isAbsolute(rel) || rel === "") {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: 'Path escape detected: resolved target "' + targetJobDir + '" escapes jobsRoot "' + realJobsRoot + '".',
        remediation: "Ensure expectedJobName resolves within jobsRoot.",
        retryable: false,
      });
    }

    if (existsSync(targetJobDir)) {
      const realTarget = realpathSync(targetJobDir);
      if (!realTarget.startsWith(realJobsRoot + sep) && realTarget !== realJobsRoot) {
        throw new ActionableBenchmarkError({
          code: "CONFIG_INVALID",
          message: 'Symlink escape detected: "' + targetJobDir + '" points outside jobsRoot.',
          remediation: "Ensure jobsRoot does not contain escaping symlinks.",
          retryable: false,
        });
      }
    }

    if (typeof request.timeoutMs !== "number" || request.timeoutMs <= 0 || !Number.isFinite(request.timeoutMs)) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: "HarborJobRequest.timeoutMs must be a positive finite number.",
        remediation: "Specify a timeoutMs value > 0.",
        retryable: false,
      });
    }

    if (!request.successCriterion || typeof request.successCriterion !== "string") {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: "HarborJobRequest.successCriterion must be a non-empty string expression.",
        remediation: "Specify a success criterion expression such as 'reward >= 1.0'.",
        retryable: false,
      });
    }

    // Mandatory checksum authority enforcement (discriminated union)
    let expectedChecksum: string;
    const reqRecord = request as unknown as Record<string, unknown>;
    const hasExpectedChecksum = typeof reqRecord["expectedTaskChecksum"] === "string" && (reqRecord["expectedTaskChecksum"] as string).trim().length > 0;
    const hasTaskDirectory = typeof reqRecord["taskDirectory"] === "string" && (reqRecord["taskDirectory"] as string).trim().length > 0;

    if (!hasExpectedChecksum && !hasTaskDirectory) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: "Mandatory checksum authority missing: HarborJobRequest requires either expectedTaskChecksum or an existing taskDirectory. Uncontrolled execution is forbidden.",
        remediation: "Specify either expectedTaskChecksum or an existing taskDirectory in HarborJobRequest.",
        retryable: false,
      });
    }

    if (hasTaskDirectory) {
      const taskDirPath = reqRecord["taskDirectory"] as string;
      if (!existsSync(taskDirPath)) {
        throw new ActionableBenchmarkError({
          code: "CONFIG_INVALID",
          message: `Task directory not found: "${taskDirPath}". Checksum authority requires an existing directory path.`,
          remediation: "Ensure the taskDirectory path exists on disk.",
          retryable: false,
        });
      }
      const calculatedHash = computeTaskChecksum(taskDirPath);
      if (hasExpectedChecksum && reqRecord["expectedTaskChecksum"] !== calculatedHash) {
        throw new ActionableBenchmarkError({
          code: "CONFIG_INVALID",
          message: `Contradictory checksum authority: expectedTaskChecksum "${String(reqRecord["expectedTaskChecksum"])}" does not match taskDirectory hash "${calculatedHash}".`,
          remediation: "Provide matching expectedTaskChecksum and taskDirectory, or specify only one authority.",
          retryable: false,
        });
      }
      expectedChecksum = calculatedHash;
    } else {
      const chk = (reqRecord["expectedTaskChecksum"] as string).trim();
      if (!/^[0-9a-f]{64}$/i.test(chk)) {
        throw new ActionableBenchmarkError({
          code: "CONFIG_INVALID",
          message: `Invalid expectedTaskChecksum "${chk}": must be a 64-character hexadecimal SHA-256 hash.`,
          remediation: "Provide a valid 64-character hex task checksum.",
          retryable: false,
        });
      }
      if (/^0{64}$/i.test(chk) || /^f{64}$/i.test(chk)) {
        throw new ActionableBenchmarkError({
          code: "CONFIG_INVALID",
          message: `Placeholder expectedTaskChecksum "${chk}" rejected. Authentic task hash is required.`,
          remediation: "Provide the authentic computed checksum of the task.",
          retryable: false,
        });
      }
      expectedChecksum = chk;
    }

    // 1b. MANDATORY preflight gate (R5 item 8, kept in R6): verification can
    // no longer be bypassed by calling run() directly.
    const gate = await this.mandatoryPreflight();
    this.lastRunContainerRuntime = gate.containerRuntime;

    // TOCTOU best-effort: re-hash the resolved launcher immediately before
    // exec and reject replacement between verification and execution.
    if (gate.launcherAbs) {
      const hashNow = sha256OfExecutable(gate.launcherAbs);
      if (!hashNow || (gate.launcherHashAtPreflight && hashNow !== gate.launcherHashAtPreflight)) {
        throw new ActionableBenchmarkError({
          code: "HARNESS_UNAVAILABLE",
          message: "Harbor launcher changed between verification and execution (TOCTOU guard).",
          remediation: "Ensure no process replaces the Harbor executable during a run.",
          retryable: false,
        });
      }
    }

    // 2. Validate manifest on disk
    const manifestRaw = readFileSync(request.jobConfigPath, "utf8");
    const manifestParsed = parseHarborJobYaml(manifestRaw);
    let manifestConfig;
    try {
      manifestConfig = harborJobConfigSchema.parse(manifestParsed);
    } catch (err) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: 'Manifest schema validation failed for "' + request.jobConfigPath + '": ' + (err instanceof Error ? err.message : String(err)),
        remediation: "Ensure the manifest declares required fields (e.g. agents, tasks or datasets).",
        retryable: false,
      });
    }

    const rawManifestObj =
      manifestParsed && typeof manifestParsed === "object"
        ? (manifestParsed as Record<string, unknown>)
        : {};

    if (
      typeof rawManifestObj["job_name"] === "string" &&
      manifestConfig.job_name !== request.expectedJobName
    ) {
      throw new ActionableBenchmarkError({
        code: "CONFIG_INVALID",
        message: 'Manifest job_name "' + manifestConfig.job_name + '" contradicts expectedJobName "' + request.expectedJobName + '".',
        remediation: "Ensure manifest job_name aligns with expectedJobName.",
        retryable: false,
      });
    }

    const hasExplicitJobsDir =
      typeof rawManifestObj["jobs_dir"] === "string" &&
      (rawManifestObj["jobs_dir"] as string).trim().length > 0;

    if (hasExplicitJobsDir && manifestConfig.jobs_dir) {
      const manifestJobsDir = manifestConfig.jobs_dir;
      let manifestResolvedJobsDir: string;
      if (isAbsolute(manifestJobsDir)) {
        manifestResolvedJobsDir = existsSync(manifestJobsDir)
          ? realpathSync(manifestJobsDir)
          : resolve(manifestJobsDir);
      } else {
        const candidate = resolve(dirname(request.jobConfigPath), manifestJobsDir);
        manifestResolvedJobsDir = existsSync(candidate)
          ? realpathSync(candidate)
          : candidate;
      }
      if (
        manifestResolvedJobsDir !== realJobsRoot &&
        manifestJobsDir !== request.expectedJobName &&
        !realJobsRoot.endsWith(sep + manifestJobsDir)
      ) {
        throw new ActionableBenchmarkError({
          code: "CONFIG_INVALID",
          message: `Manifest jobs_dir "${manifestJobsDir}" contradicts request.jobsRoot "${request.jobsRoot}".`,
          remediation: "Ensure manifest jobs_dir aligns with request.jobsRoot.",
          retryable: false,
        });
      }
    }

    // 3. Record pre-execution state for freshness & anti-tamper binding
    const runStartedAtMs = Date.now();
    const targetResultJson = join(targetJobDir, "result.json");
    let preExistingResultHash: string | null = null;
    let preExistingJobId: string | null = null;
    const preExistingTrialHashes = new Map<string, string>(); // trialDirName -> sha256
    const preExistingTrialIds = new Set<string>();

    if (existsSync(targetJobDir)) {
      if (existsSync(targetResultJson)) {
        try {
          const preContent = readFileSync(targetResultJson, "utf8");
          preExistingResultHash = createHash("sha256").update(preContent).digest("hex");
          const parsedPre = JSON.parse(preContent) as Record<string, unknown>;
          if (typeof parsedPre["id"] === "string") {
            preExistingJobId = parsedPre["id"];
          }
        } catch {
          // malformed pre-existing file
        }
      }

      // Pre-scan all existing trial directories and snapshot their result.json hashes & IDs
      try {
        const preEntries = readdirSync(targetJobDir, { withFileTypes: true });
        for (const entry of preEntries) {
          if (entry.isDirectory()) {
            const preTrialResultPath = join(targetJobDir, entry.name, "result.json");
            if (existsSync(preTrialResultPath)) {
              try {
                const preTrialContent = readFileSync(preTrialResultPath, "utf8");
                const hash = createHash("sha256").update(preTrialContent).digest("hex");
                preExistingTrialHashes.set(entry.name, hash);
                const parsed = JSON.parse(preTrialContent) as Record<string, unknown>;
                if (typeof parsed["id"] === "string") {
                  preExistingTrialIds.add(parsed["id"]);
                }
              } catch {
                // ignore unreadable pre-existing files
              }
            }
          }
        }
      } catch {
        // ignore errors reading pre-existing directory
      }
    }

    // 4. Execute Harbor CLI (via the verified absolute launcher when resolved)
    const launcherAbs = this.resolveLauncherAbs();
    const execArgs = [...this.harborPrefixArgs, "run", "-c", request.jobConfigPath];
    const execRes = await this.executor.execute({
      command: launcherAbs ?? this.harborExecutable,
      args: execArgs,
      cwd: process.cwd(),
      ...(this.env ? { env: this.env } : {}),
      timeoutMs: request.timeoutMs,
    });

    if (execRes.timedOut) {
      throw new ActionableBenchmarkError({
        code: "TRIAL_TIMEOUT",
        message: 'Harbor job execution timed out after ' + request.timeoutMs + 'ms',
        remediation: "Increase timeoutMs or investigate job hangs.",
        retryable: false,
      });
    }

    if (execRes.exitCode !== 0) {
      throw new ActionableBenchmarkError({
        code: "HARNESS_UNAVAILABLE",
        message: 'Harbor CLI exited with code ' + execRes.exitCode + ': ' + (execRes.stderr || execRes.stdout).trim(),
        remediation: "Check Harbor CLI execution logs and manifest configuration.",
        retryable: false,
        details: { stdout: execRes.stdout, stderr: execRes.stderr, exitCode: execRes.exitCode },
      });
    }

    // 5. Verify Output Directory Exists
    if (!existsSync(targetJobDir)) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: 'Job output directory not found after execution: "' + targetJobDir + '"',
        remediation: "Ensure harbor run generates output directory matching expectedJobName under jobsRoot.",
        retryable: false,
      });
    }

    if (!existsSync(targetResultJson)) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: 'Job result.json missing in output directory: "' + targetJobDir + '"',
        remediation: "Ensure harbor run writes a valid result.json upon completion.",
        retryable: false,
      });
    }

    // Freshness & Anti-tamper verification
    const postExecStat = statSync(targetResultJson);
    if (postExecStat.mtimeMs < runStartedAtMs - 200) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: 'Stale artifacts detected: result.json modification time (' + postExecStat.mtimeMs + ') predates run execution (' + runStartedAtMs + ').',
        remediation: "Ensure the executor produces fresh execution artifacts and does not rely on stale pre-existing outputs.",
        retryable: false,
      });
    }

    const postExecContent = readFileSync(targetResultJson, "utf8");
    const postExecHash = createHash("sha256").update(postExecContent).digest("hex");
    if (preExistingResultHash !== null && postExecHash === preExistingResultHash) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: "Stale artifacts detected: result.json content is unchanged from pre-execution file. Merely touching timestamps without generating fresh execution results is rejected.",
        remediation: "Ensure the execution produces fresh output artifacts.",
        retryable: false,
      });
    }

    // 6. Load & Validate JobResult
    let rawJobResult: unknown;
    try {
      rawJobResult = JSON.parse(postExecContent);
    } catch {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: "Malformed JSON in " + targetResultJson,
        remediation: "Ensure result.json is valid JSON.",
        retryable: false,
      });
    }

    const jobResult = harborJobResultSchema.parse(rawJobResult);

    if (preExistingJobId !== null && jobResult.id === preExistingJobId) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: 'Stale artifacts detected: jobResult.id "' + jobResult.id + '" matches pre-existing job ID.',
        remediation: "Ensure the execution produces fresh job results with a new run ID.",
        retryable: false,
      });
    }

    // JobResult finished_at MUST be present and valid
    if (!jobResult.finished_at) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: "JobResult.finished_at is null or missing for completed job.",
        remediation: "Harbor job must declare a valid finished_at ISO timestamp upon completion.",
        retryable: false,
      });
    }

    const jobStartedMs = new Date(jobResult.started_at).getTime();
    const jobFinishedMs = new Date(jobResult.finished_at).getTime();

    if (jobStartedMs < runStartedAtMs - 2000) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: 'Stale artifacts detected: JobResult.started_at (' + jobResult.started_at + ') predates run execution (' + new Date(runStartedAtMs).toISOString() + ').',
        remediation: "Ensure job results are genuinely produced by the current run.",
        retryable: false,
      });
    }

    if (jobFinishedMs < jobStartedMs) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: "Inverted JobResult execution timing: finished_at predates started_at.",
        remediation: "Ensure timestamps are chronological.",
        retryable: false,
      });
    }

    // Reject empty job with zero trials fail-closed
    if (jobResult.n_total_trials === 0 || jobResult.stats.n_trials === 0) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: "Zero-trial job rejected: JobResult declares " + jobResult.n_total_trials + " total trials and " + jobResult.stats.n_trials + " completed trials.",
        remediation: "Harbor job must execute at least one evaluated trial.",
        retryable: false,
      });
    }

    // Reject error trials fail-closed, except expected A2 gate blocks when
    // the interception session explicitly allows them (R7 item 4): Harbor
    // 0.1.2 records ShokuninGateBlocked in exception_info AND increments
    // n_errors. The per-trial proof (GateBlocked-only exception, absent
    // verifier, BLOCK transcript) is verified below during trial inspection.
    if (jobResult.stats.n_errors !== 0 && !options.allowExpectedGateBlocked) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: "Job execution resulted in " + jobResult.stats.n_errors + " trial errors.",
        remediation: "Investigate trial errors in Harbor output.",
        retryable: false,
      });
    }

    // Extract manifest declared agents and tasks for cross-link validation
    const rawAgents = Array.isArray(manifestConfig.agents) ? manifestConfig.agents : [];
    const manifestAgentNames = new Set<string>();
    for (const ag of rawAgents) {
      if (typeof ag === "object" && ag && "name" in ag && typeof (ag as { name: unknown }).name === "string") {
        manifestAgentNames.add((ag as { name: string }).name);
      }
    }

    const rawTasks = Array.isArray(manifestConfig.tasks) ? manifestConfig.tasks : [];
    const manifestTaskPaths = new Set<string>();
    for (const t of rawTasks) {
      if (typeof t === "object" && t && "path" in t && typeof (t as { path: unknown }).path === "string") {
        manifestTaskPaths.add((t as { path: string }).path);
      } else if (typeof t === "string") {
        manifestTaskPaths.add(t);
      }
    }
    if (request.taskDirectory) {
      manifestTaskPaths.add(basename(request.taskDirectory));
      manifestTaskPaths.add(request.taskDirectory);
    }

    // 7. Discover trial directories and verify bidirectional cardinality
    const childEntries = readdirSync(targetJobDir, { withFileTypes: true });
    const trialDirs = childEntries
      .filter((e) => e.isDirectory() && existsSync(join(targetJobDir, e.name, "result.json")))
      .map((e) => e.name);

    const rawJobTrials = (jobResult as Record<string, unknown>)["trials"];
    const hasExplicitTrials = Array.isArray(rawJobTrials);

    if (
      trialDirs.length !== jobResult.n_total_trials ||
      jobResult.stats.n_trials !== jobResult.n_total_trials ||
      (hasExplicitTrials && (rawJobTrials as unknown[]).length !== jobResult.n_total_trials)
    ) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message:
          'Contradictory trial counts: found ' +
          trialDirs.length +
          ' on-disk trial directories, JobResult.n_total_trials is ' +
          jobResult.n_total_trials +
          ', and JobResult.stats.n_trials is ' +
          jobResult.stats.n_trials,
        remediation: "Ensure all trials are recorded in JobResult and present on disk with zero orphan trials.",
        retryable: false,
      });
    }

    // Bijective validation: JobResult.trials <-> on-disk trial directories
    const onDiskTrialDirSet = new Set(trialDirs);
    if (hasExplicitTrials) {
      const declaredTrialNames = new Set<string>();
      for (const entry of rawJobTrials as Array<Record<string, unknown>>) {
        const declaredJob = typeof entry["job_name"] === "string" ? entry["job_name"] : "";
        const declaredTrial = typeof entry["trial_name"] === "string" ? entry["trial_name"] : "";

        if (declaredJob !== request.expectedJobName) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `JobResult.trials references foreign job_name "${declaredJob}", expected "${request.expectedJobName}".`,
            remediation: "Ensure all trials in JobResult belong to expectedJobName.",
            retryable: false,
          });
        }

        if (!onDiskTrialDirSet.has(declaredTrial)) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `JobResult declares trial "${declaredTrial}" which does not exist on disk in "${targetJobDir}". Ghost trials are rejected.`,
            remediation: "Ensure every declared trial has a corresponding on-disk directory.",
            retryable: false,
          });
        }

        if (declaredTrialNames.has(declaredTrial)) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Duplicate trial "${declaredTrial}" declared in JobResult.trials.`,
            remediation: "Ensure trial names in JobResult are unique.",
            retryable: false,
          });
        }
        declaredTrialNames.add(declaredTrial);
      }

      if (declaredTrialNames.size !== onDiskTrialDirSet.size) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Mismatch between declared JobResult trials (${declaredTrialNames.size}) and discovered on-disk trials (${onDiskTrialDirSet.size}).`,
          remediation: "Ensure exact 1-to-1 bijection between JobResult trials and on-disk trial directories.",
          retryable: false,
        });
      }
    }

    // 8. Inspect each trial result
    const trialReferences: HarborTrialReference[] = [];
    let gateBlockedCount = 0;
    let exceptionTrialCount = 0;

    for (const trialDirName of trialDirs) {
      const trialDir = join(targetJobDir, trialDirName);
      const trialConfigPath = join(trialDir, "config.json");
      const trialResultPath = join(trialDir, "result.json");

      if (!existsSync(trialConfigPath)) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial config.json missing in "' + trialDirName + '"',
          remediation: "Ensure each trial directory contains a valid config.json.",
          retryable: false,
        });
      }

      let rawTrialCfg: Record<string, unknown>;
      try {
        rawTrialCfg = JSON.parse(readFileSync(trialConfigPath, "utf8"));
      } catch (err) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Malformed JSON in trial config: "' + trialConfigPath + '"',
          remediation: "Ensure trial config.json is valid JSON.",
          retryable: false,
        });
      }

      if (!rawTrialCfg["job_id"] || typeof rawTrialCfg["job_id"] !== "string") {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial config.json in "' + trialDirName + '" is missing mandatory job_id.',
          remediation: "Ensure trial config declares job_id matching parent job.",
          retryable: false,
        });
      }

      if (rawTrialCfg["job_id"] !== jobResult.id) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial config job_id "' + String(rawTrialCfg["job_id"]) + '" contradicts JobResult id "' + jobResult.id + '"',
          remediation: "Ensure trials are correlated with parent JobResult.",
          retryable: false,
        });
      }

      // Check trial config agent alignment with manifest
      const trialCfgAgent = rawTrialCfg["agent"] as Record<string, unknown> | undefined;
      if (trialCfgAgent && typeof trialCfgAgent["name"] === "string" && manifestAgentNames.size > 0) {
        if (!manifestAgentNames.has(trialCfgAgent["name"])) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Trial config agent "${trialCfgAgent["name"]}" contradicts manifest agents.`,
            remediation: "Ensure trial config agent aligns with manifest.",
            retryable: false,
          });
        }
      }

      if (!existsSync(trialResultPath)) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial result missing: "' + trialResultPath + '"',
          remediation: "Ensure each trial completes with result.json.",
          retryable: false,
        });
      }

      // Check trial freshness & anti-touch protection
      const trialStat = statSync(trialResultPath);
      if (trialStat.mtimeMs < runStartedAtMs - 200) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Stale trial artifact detected in "' + trialDirName + '": mtime predates run execution.',
          remediation: "Ensure trial artifacts are fresh.",
          retryable: false,
        });
      }

      const postTrialContent = readFileSync(trialResultPath, "utf8");
      const postTrialHash = createHash("sha256").update(postTrialContent).digest("hex");
      const preHash = preExistingTrialHashes.get(trialDirName);
      if (preHash !== undefined && postTrialHash === preHash) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Stale trial artifact detected in "${trialDirName}": trial result content is unchanged from pre-execution state. Merely touching timestamps without generating fresh trial results is rejected.`,
          remediation: "Ensure each trial execution produces freshly generated output artifacts.",
          retryable: false,
        });
      }

      // Validate trial result against schema
      let rawTrialResult: unknown;
      try {
        rawTrialResult = JSON.parse(postTrialContent);
      } catch {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Malformed JSON in "' + trialResultPath + '"',
          remediation: "Ensure trial result.json is valid JSON.",
          retryable: false,
        });
      }

      const trialResult = harborTrialResultSchema.parse(rawTrialResult);

      if (preExistingTrialIds.has(trialResult.id)) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Stale trial artifact detected in "${trialDirName}": trial id "${trialResult.id}" matches a pre-existing trial ID from before the run.`,
          remediation: "Ensure the execution produces fresh trials with unique identifiers.",
          retryable: false,
        });
      }

      // Verify trial_name matches directory name
      if (trialResult.trial_name !== trialDirName) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial name mismatch: trialResult.trial_name "' + trialResult.trial_name + '" contradicts directory name "' + trialDirName + '".',
          remediation: "Ensure trial_name matches directory name.",
          retryable: false,
        });
      }

      // Verify finished_at is present and chronological
      if (!trialResult.finished_at) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial "' + trialResult.id + '" has null or missing finished_at timestamp.',
          remediation: "Ensure completed trials record a valid finished_at timestamp.",
          retryable: false,
        });
      }

      const trialStartedMs = trialResult.started_at ? new Date(trialResult.started_at).getTime() : 0;
      const trialFinishedMs = new Date(trialResult.finished_at).getTime();

      if (trialResult.started_at && trialStartedMs < runStartedAtMs - 2000) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Stale trial detected: trial "' + trialResult.id + '" started_at predates run execution.',
          remediation: "Ensure trial results are fresh.",
          retryable: false,
        });
      }

      if (trialResult.started_at && trialFinishedMs < trialStartedMs) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial "' + trialResult.id + '" has inverted timing: finished_at predates started_at.',
          remediation: "Ensure trial timings are chronological.",
          retryable: false,
        });
      }

      // Verify trial ID correlation with JobResult — inner config.job_id MANDATORY.
      const trialConfigJobId = (trialResult.config as Record<string, unknown>)["job_id"];
      if (typeof trialConfigJobId !== "string" || trialConfigJobId.length === 0) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Trial "${trialResult.id}" is missing mandatory result.config.job_id.`,
          remediation: "Ensure every trial result declares config.job_id matching the parent job.",
          retryable: false,
        });
      }
      if (trialConfigJobId !== jobResult.id) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial result.config.job_id "' + String(trialConfigJobId) + '" contradicts JobResult id "' + jobResult.id + '"',
          remediation: "Ensure trial belongs to parent job.",
          retryable: false,
        });
      }

      // Reject placeholder hashes (e.g. 64 zeros or 64 f's)
      if (/^0{64}$/i.test(trialResult.task_checksum) || /^f{64}$/i.test(trialResult.task_checksum)) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial "' + trialResult.id + '" has placeholder task_checksum "' + trialResult.task_checksum + '"; genuine hash required.',
          remediation: "Ensure task checksum is computed from task directory structure.",
          retryable: false,
        });
      }

      // Semantic task checksum comparison (mandatory authority)
      if (trialResult.task_checksum !== expectedChecksum) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: 'Trial "' + trialResult.id + '" task_checksum mismatch: expected "' + expectedChecksum + '", got "' + trialResult.task_checksum + '"',
          remediation: "Ensure task contents have not been altered and checksum matches task directory.",
          retryable: false,
        });
      }

      // Verify trial_uri: EXACT realpath equality with the discovered trial
      // directory (R6: suffix confinement was insufficient for homonyms).
      assertTrialUriExact(trialResult.trial_uri, join(targetJobDir, trialDirName));

      // Verify agent consistency with manifest. Bridge trials declare the
      // lab-owned wrapper (import_path) in config while agent_info mirrors
      // the INNER experiment agent (kwargs shokunin_inner_agent) — both links
      // are verified, neither may float free.
      const trialConfigAgentForInfo = (trialResult.config as Record<string, unknown>)?.["agent"] as
        | Record<string, unknown>
        | undefined;
      const bridgeInnerAgent =
        trialConfigAgentForInfo && typeof trialConfigAgentForInfo["import_path"] === "string"
          ? (trialConfigAgentForInfo["kwargs"] as Record<string, unknown> | undefined)?.["shokunin_inner_agent"]
          : undefined;
      const trialAgentName = trialResult.agent_info?.name;
      if (manifestAgentNames.size > 0 && trialAgentName) {
        const allowedAgentNames = new Set(manifestAgentNames);
        if (typeof bridgeInnerAgent === "string" && bridgeInnerAgent.length > 0) {
          allowedAgentNames.add(bridgeInnerAgent);
        }
        if (!allowedAgentNames.has(trialAgentName)) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Trial agent "${trialAgentName}" contradicts manifest agents: [${Array.from(manifestAgentNames).join(", ")}].`,
            remediation: "Ensure trial agent matches manifest declared agent (or the bridge-declared inner agent).",
            retryable: false,
          });
        }
      }
      const trialResConfigAgent = (trialResult.config as Record<string, unknown>)?.["agent"] as Record<string, unknown> | undefined;
      if (trialResConfigAgent && typeof trialResConfigAgent["name"] === "string" && manifestAgentNames.size > 0) {
        if (!manifestAgentNames.has(trialResConfigAgent["name"])) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Trial config agent "${trialResConfigAgent["name"]}" contradicts manifest agents.`,
            remediation: "Ensure trial config agent aligns with manifest.",
            retryable: false,
          });
        }
      }

      // Verify task consistency with manifest — EXACT match required (no fuzzy basename).
      const trialTaskPath =
        typeof trialResult.task_id === "object" && trialResult.task_id && "path" in trialResult.task_id
          ? (trialResult.task_id as { path: string }).path
          : trialResult.task_name;
      if (manifestTaskPaths.size > 0 && trialTaskPath) {
        if (!manifestTaskPaths.has(trialTaskPath)) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Trial task "${trialTaskPath}" contradicts manifest tasks: [${Array.from(manifestTaskPaths).join(", ")}]. Exact match required.`,
            remediation: "Ensure trial task matches manifest declared task exactly.",
            retryable: false,
          });
        }
      }
      // Inner config.task.path MANDATORY and exact.
      const innerTask = (trialResult.config as Record<string, unknown>)["task"] as
        | Record<string, unknown>
        | undefined;
      if (!innerTask || typeof innerTask["path"] !== "string" || (innerTask["path"] as string).length === 0) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Trial "${trialResult.id}" is missing mandatory config.task.path.`,
          remediation: "Ensure every trial result declares config.task.path matching the manifest task.",
          retryable: false,
        });
      }
      if (manifestTaskPaths.size > 0 && !manifestTaskPaths.has(innerTask["path"] as string)) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Trial config.task.path "${String(innerTask["path"])}" contradicts manifest tasks: [${Array.from(manifestTaskPaths).join(", ")}]. Exact match required.`,
          remediation: "Ensure trial config task path matches manifest declared task exactly.",
          retryable: false,
        });
      }

      // Validate success criterion expression against declared rewards.
      // Trials whose verifier never ran carry verifier_result null (blocked,
      // errored); the criterion applies only when rewards were observed.
      if (trialResult.verifier_result !== null) {
        evaluateSuccessCriterion(
          trialResult.verifier_result.rewards,
          request.successCriterion,
        );
      }
      // NOTE: We intentionally do NOT throw when criterion evaluates to false.
      // An evaluated task failure (e.g. reward = 0) is a valid evaluated trial, not an infrastructure error.

      // Expected A2 gate blocks (R7 item 4, R8 strict proof): when the session
      // allows them, each errored trial is classified HERE, never downstream:
      // - ShokuninGateBlocked (EXACT match) + absent verifier + parsed marker
      //   with exact trial name and internal BLOCK + corroborating BLOCK
      //   verdict: proven prevention, tolerated and counted;
      // - any exception WITH a ran verifier (e.g. agent timeouts, which
      //   Harbor verifies anyway): tolerated, classified downstream;
      // - any OTHER error WITHOUT verifier evidence: rejected fail-closed.
      if (options.allowExpectedGateBlocked) {
        const exceptionType =
          trialResult.exception_info && typeof trialResult.exception_info === "object"
            ? (trialResult.exception_info as { exception_type?: unknown }).exception_type
            : null;
        if (exceptionType !== null && exceptionType !== undefined) {
          const verifierAbsent =
            (trialResult as { verifier?: unknown }).verifier === null ||
            (trialResult as { verifier?: unknown }).verifier === undefined;
          if (exceptionType === "ShokuninGateBlocked") {
            const proof = isProvenGateBlock({
              trialName: trialResult.trial_name,
              exceptionType,
              blockedRaw: readJsonIfExists(join(trialDir, "gate-blocked.json")),
              verdictRaw: readJsonIfExists(join(trialDir, "gate-verdict.json")),
            });
            if (!verifierAbsent || !proof.proven) {
              throw new ActionableBenchmarkError({
                code: "RESULT_INVALID",
                message: `Trial "${trialResult.id}" claims gate prevention but prevention is unproven (${proof.reason}) or carries verifier evidence: A2+BLOCK is licit only with absent verifier and a coherent BLOCK transcript.`,
                remediation: "A2+BLOCK is licit only with absent verifier and the bridge BLOCK transcript.",
                retryable: false,
              });
            }
            gateBlockedCount += 1;
          } else if (verifierAbsent) {
            throw new ActionableBenchmarkError({
              code: "RESULT_INVALID",
              message: `Trial "${trialResult.id}" carries exception "${String(exceptionType)}" without verifier evidence: not an expected A2 gate block.`,
              remediation: "Only bridge-proven gate prevention is tolerated; investigate any other trial error.",
              retryable: false,
            });
          }
          exceptionTrialCount += 1;
        }
      }

      trialReferences.push({
        jobName: request.expectedJobName,
        trialName: trialDirName,
        resultPath: trialResultPath,
      });
    }

    // Every job-counted error must have been observed on a trial directory
    // (proven blocks plus verifier-backed exceptions); nothing unaccounted.
    if (options.allowExpectedGateBlocked && exceptionTrialCount !== jobResult.stats.n_errors) {
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: `Exception trial count (${exceptionTrialCount}, of which ${gateBlockedCount} proven gate blocks) contradicts job error count (${jobResult.stats.n_errors}).`,
        remediation: "Every job error must correspond to an observed trial exception.",
        retryable: false,
      });
    }

    return {
      exitCode: 0,
      stdout: execRes.stdout,
      stderr: execRes.stderr,
      jobDirectory: targetJobDir,
      trials: trialReferences,
    };
  }

}