import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";

/**
 * @fileoverview Interprocess file lock (R6 item 8).
 *
 * `withFileLock(filePath, timeoutMs, fn)` serializes critical sections across
 * processes via an exclusive `<filePath>.lock` directory holding a holder
 * stamp (pid + timestamp) with staleness recovery. NDJSON read-check-write
 * and ledger appends MUST run inside it — checking uniqueness before the
 * lock let two concurrent writers persist the same ID (R5 review P1).
 */
export async function withFileLock<T>(
  filePath: string,
  timeoutMs: number,
  fn: () => Promise<T> | T,
): Promise<T> {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  const lockDir = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  // Acquire ONLY: retry loop covers mkdir exclusivity alone. The critical
  // section runs exactly once below — fn() errors must propagate, never be
  // mistaken for lock contention (that bug turned every duplicate-ID
  // rejection into a 5s timeout).
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      try {
        const stamp = readFileSync(`${lockDir}/holder.json`, "utf8");
        const parsed = JSON.parse(stamp) as { at?: number };
        if (typeof parsed.at === "number" && Date.now() - parsed.at > 30000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // active lock without readable stamp
      }
      if (Date.now() >= deadline) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Lock contention: could not acquire ${lockDir} within ${timeoutMs}ms.`,
          remediation: "Serialize concurrent writers or raise the lock timeout.",
          retryable: true,
          details: { filePath },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    writeFileSync(`${lockDir}/holder.json`, JSON.stringify({ at: Date.now(), pid: process.pid }));
  } catch {
    // best-effort staleness marker
  }
  try {
    return await fn();
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // ignore release errors
    }
  }
}
