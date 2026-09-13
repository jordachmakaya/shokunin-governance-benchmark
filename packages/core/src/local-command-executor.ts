import { spawn } from "node:child_process";
import type {
  CommandExecutionResult,
  CommandRequest,
  ICommandExecutor,
} from "../contracts/executor.contract.js";

const DEFAULT_MAX_BUFFER_BYTES = 2 * 1024 * 1024; // 2 MB cap to prevent OOM
const DRAIN_TIMEOUT_MS = 500; // Time to wait for pipes after exit before resolving

// Standard system environment keys safe to pass to subprocesses
const DEFAULT_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "NODE",
  "NODE_ENV",
  "PNPM_HOME",
  "CI",
]);

export interface LocalCommandExecutorOptions {
  readonly maxBufferBytes?: number;
  readonly envAllowlist?: ReadonlySet<string>;
}

export function filterSafeEnvironment(
  explicitEnv?: Readonly<Record<string, string>>,
  allowlist: ReadonlySet<string> = DEFAULT_ENV_ALLOWLIST,
): Record<string, string> {
  const safeEnv: Record<string, string> = {};

  // Pass only allowlisted system variables from process.env
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && allowlist.has(key)) {
      safeEnv[key] = value;
    }
  }

  // Merge any explicitly requested environment variables
  if (explicitEnv) {
    for (const [key, value] of Object.entries(explicitEnv)) {
      if (value !== undefined) {
        safeEnv[key] = value;
      }
    }
  }

  return safeEnv;
}

export class LocalCommandExecutor implements ICommandExecutor {
  private readonly maxBufferBytes: number;
  private readonly envAllowlist: ReadonlySet<string>;

  constructor(options: LocalCommandExecutorOptions = {}) {
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.envAllowlist = options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST;
  }

  async execute(request: CommandRequest): Promise<CommandExecutionResult> {
    const startedAt = Date.now();

    return new Promise<CommandExecutionResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let isResolved = false;
      let drainTimer: NodeJS.Timeout | null = null;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;

      let child: ReturnType<typeof spawn>;
      try {
        const executionEnv = filterSafeEnvironment(request.env, this.envAllowlist);

        child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: executionEnv,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true, // Process group to enable killing entire tree
        });
      } catch (err: unknown) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return resolve({
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: errorMsg,
          durationMs: Date.now() - startedAt,
          timedOut: false,
        });
      }

      const killProcessTree = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore if already dead
            }
          }
        }
      };

      const finish = () => {
        if (isResolved) return;
        isResolved = true;
        if (timer) clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);

        if (stdoutTruncated) {
          stdout += `\n[WARN: stdout truncated after exceeding ${this.maxBufferBytes} bytes]`;
        }
        if (stderrTruncated) {
          stderr += `\n[WARN: stderr truncated after exceeding ${this.maxBufferBytes} bytes]`;
        }

        resolve({
          exitCode,
          signal: exitSignal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree();
        setTimeout(() => {
          finish();
        }, 300);
      }, request.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBytes < this.maxBufferBytes) {
          const toAdd = chunk.subarray(0, this.maxBufferBytes - stdoutBytes);
          stdout += toAdd.toString("utf8");
          stdoutBytes += toAdd.length;
          if (chunk.length > toAdd.length) {
            stdoutTruncated = true;
          }
        } else {
          stdoutTruncated = true;
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes < this.maxBufferBytes) {
          const toAdd = chunk.subarray(0, this.maxBufferBytes - stderrBytes);
          stderr += toAdd.toString("utf8");
          stderrBytes += toAdd.length;
          if (chunk.length > toAdd.length) {
            stderrTruncated = true;
          }
        } else {
          stderrTruncated = true;
        }
      });

      child.on("error", (err: Error) => {
        stderr = `${stderr}\n${err.message}`.trim();
        finish();
      });

      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        exitCode = code;
        exitSignal = signal;

        drainTimer = setTimeout(() => {
          killProcessTree();
          finish();
        }, DRAIN_TIMEOUT_MS);
      });

      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (exitCode === null) exitCode = code;
        if (exitSignal === null) exitSignal = signal;
        finish();
      });
    });
  }
}
