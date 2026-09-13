import { chmodSync, existsSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";

/**
 * @fileoverview Shared snapshot filesystem primitives (R6).
 *
 * Single home for: regular-file walks, special-file closure (symlinks,
 * sockets, FIFOs, devices rejected pre- and post-copy), read-only sealing
 * and writable restore, best-effort removal. Used by the interception
 * session (pre-gate hash + read-only gate window) and the vertical slice
 * (sealing + TOCTOU re-verification).
 */
export function walkRegularFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const st = lstatSync(full);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      walkRegularFiles(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export function snapshotFileBytes(dir: string): { fileCount: number; totalBytes: number } {
  const files = walkRegularFiles(dir);
  let totalBytes = 0;
  for (const f of files) {
    try {
      totalBytes += statSync(f).size;
    } catch {
      // ignore races on live trees
    }
  }
  return { fileCount: files.length, totalBytes };
}

/**
 * Snapshot closure: rejects symlinks, sockets, FIFOs, devices and any
 * special file. Such entries are never hashed, never copied, never gated —
 * the seal fails closed instead (SYMLINK_ESCAPE fix).
 */
export function assertNoSpecialFiles(root: string): void {
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        failResult(`Snapshot entry unreadable: "${full}".`, "Ensure snapshot sources are stable on-disk directories.");
      }
      if (st!.isSymbolicLink()) {
        failResult(
          `Snapshot symlink rejected: "${full}". Symlinks can point outside the sealed root and change after sealing (SYMLINK_ESCAPE).`,
          "Remove symlinks from trial workspaces or materialize their targets as regular files before sealing.",
          { path: full },
        );
      }
      if (st!.isDirectory()) {
        stack.push(full);
      } else if (!st!.isFile()) {
        failResult(
          `Snapshot special file rejected: "${full}" (socket, FIFO, device or other non-regular file).`,
          "Snapshots contain regular files and directories only.",
          { path: full },
        );
      }
    }
  }
}

function failResult(message: string, remediation: string, details?: Record<string, unknown>): never {
  throw new ActionableBenchmarkError({
    code: "RESULT_INVALID",
    message,
    remediation,
    retryable: false,
    ...(details ? { details } : {}),
  });
}

export function makeReadOnlyRecursive(root: string): void {
  for (const f of walkRegularFiles(root)) {
    try {
      chmodSync(f, 0o444);
    } catch {
      // best-effort
    }
  }
  const dirs: string[] = [root];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = join(cur, entry.name);
        dirs.push(full);
        stack.push(full);
      }
    }
  }
  for (let i = dirs.length - 1; i >= 0; i--) {
    try {
      chmodSync(dirs[i]!, 0o555);
    } catch {
      // best-effort
    }
  }
}

export function makeWritableRecursive(root: string): void {
  const stack = [root];
  const dirs: string[] = [];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    dirs.push(cur);
    let entries: import("node:fs").Dirent<string>[] = [];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        try {
          chmodSync(full, 0o644);
        } catch {
          // best-effort
        }
      }
    }
  }
  for (let i = dirs.length - 1; i >= 0; i--) {
    try {
      chmodSync(dirs[i]!, 0o755);
    } catch {
      // best-effort
    }
  }
}

export function removeDirBestEffort(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    makeWritableRecursive(dir);
  } catch {
    // ignore
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}
