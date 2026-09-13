import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { ICommandExecutor } from "@shokunin/core";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";

/**
 * @fileoverview Effective container-digest resolution (ZB2.2-R5).
 *
 * R4 bound the caller digest to manifest *text*. R5 resolves the EFFECTIVE
 * digest from the container runtime AFTER the runtime exists and compares it
 * to the manifest-pinned value. A manifest containing an invented digest can
 * no longer authenticate itself.
 */

export interface EffectiveDigest {
  readonly digest: string;
  readonly runtime: "docker" | "podman";
  readonly imageRef: string;
}

function parseRepoDigests(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        const digests = (entry as Record<string, unknown>)["RepoDigests"];
        if (Array.isArray(digests)) {
          for (const d of digests) {
            if (typeof d === "string") {
              const at = d.lastIndexOf("@");
              const candidate = at >= 0 ? d.slice(at + 1) : d;
              if (/^sha256:[0-9a-f]{64}$/i.test(candidate)) return candidate;
            }
          }
        }
        const id = (entry as Record<string, unknown>)["Id"];
        if (typeof id === "string" && /^sha256:[0-9a-f]{64}$/i.test(id)) return id;
      }
    }
    return null;
  } catch {
    const m = trimmed.match(/sha256:[0-9a-f]{64}/i);
    return m ? m[0] : null;
  }
}

/**
 * Resolves the effective image digest via `docker image inspect` (then
 * `podman`), or via the explicitly preferred runtime. Throws fail-closed
 * when no runtime answers with a digest: an unresolved digest is never
 * silently treated as verified.
 */
export async function resolveEffectiveDigest(
  imageRef: string,
  executor: ICommandExecutor,
  options: {
    readonly cwd?: string | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
    readonly preferredRuntime?: "docker" | "podman" | undefined;
    readonly timeoutMs?: number | undefined;
  } = {},
): Promise<EffectiveDigest> {
  const candidates: ("docker" | "podman")[] = options.preferredRuntime
    ? [options.preferredRuntime]
    : ["docker", "podman"];
  const errors: string[] = [];
  for (const runtime of candidates) {
    try {
      const res = await executor.execute({
        command: runtime,
        args: ["image", "inspect", imageRef],
        cwd: options.cwd ?? process.cwd(),
        ...(options.env ? { env: options.env } : {}),
        timeoutMs: options.timeoutMs ?? 15000,
      });
      if (res.timedOut || res.exitCode !== 0) {
        errors.push(`${runtime}: exit=${res.exitCode} timedOut=${res.timedOut}`);
        continue;
      }
      const digest = parseRepoDigests(res.stdout);
      if (digest) return { digest, runtime, imageRef };
      errors.push(`${runtime}: no digest in inspect output`);
    } catch (err) {
      errors.push(`${runtime}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new ActionableBenchmarkError({
    code: "HARNESS_UNAVAILABLE",
    message: `Effective container digest unresolvable for image "${imageRef}" (${errors.join("; ")}).`,
    remediation: "Ensure Docker or Podman can inspect the task image, or run in an environment with a responsive container runtime.",
    retryable: false,
    details: { imageRef, errors },
  });
}

/** SHA-256 of a resolved executable file (follows symlinks via realpath). */
export function sha256OfExecutable(absPath: string): string | null {
  try {
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return null;
    const real = realpathSync(absPath);
    return createHash("sha256").update(readFileSync(real)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Resolves an executable name to an absolute path, honouring the execution
 * environment's PATH (R4 used the process PATH even when the executor ran
 * with an overridden env PATH).
 */
export function resolveExecutableAbs(
  executable: string,
  env?: Readonly<Record<string, string>> | undefined,
): string | null {
  try {
    if (isAbsolute(executable) || executable.includes(sep) || executable.includes("/")) {
      const abs = resolve(executable);
      return existsSync(abs) ? abs : null;
    }
    const pathEnv = env?.["PATH"] ?? env?.["Path"] ?? process.env["PATH"] ?? "";
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const candidate = join(dir, executable);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}
