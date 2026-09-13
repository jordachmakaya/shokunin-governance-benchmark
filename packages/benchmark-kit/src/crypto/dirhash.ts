import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Computes a deterministic SHA-256 directory checksum matching the official
 * Harbor 0.1.2 specification: `dirhash(task_dir, "sha256")`.
 *
 * Each directory node descriptor is formed by joining sorted entry property descriptors:
 * - for sub-directories: sorted `["dirhash:<hash>", "name:<dirname>"].join("\0")`
 * - for files: sorted `["data:<sha256>", "name:<filename>"].join("\0")`
 * Joined by `\0\0`, then hashed with SHA-256.
 */
export function computeTaskChecksum(directoryPath: string): string {
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  const descriptors: string[] = [];

  for (const entry of entries) {
    const fullPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      const subHash = computeTaskChecksum(fullPath);
      const props = [`dirhash:${subHash}`, `name:${entry.name}`].sort();
      descriptors.push(props.join("\0"));
    } else if (entry.isFile()) {
      const content = readFileSync(fullPath);
      const fileHash = createHash("sha256").update(content).digest("hex");
      const props = [`data:${fileHash}`, `name:${entry.name}`].sort();
      descriptors.push(props.join("\0"));
    }
  }

  descriptors.sort();
  const descriptor = descriptors.join("\0\0");
  return createHash("sha256").update(Buffer.from(descriptor, "utf8")).digest("hex");
}
