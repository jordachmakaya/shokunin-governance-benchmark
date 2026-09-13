import { createReadStream, existsSync, mkdirSync, closeSync, fsyncSync, openSync, readFileSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname } from "node:path";
import type { ZodType } from "zod";
import type {
  INDJsonStore,
  NDJsonReadOptions,
} from "../../contracts/ndjson.contract.js";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";
import { withFileLock } from "./file-lock.js";

export interface NDJsonStoreOptions<T = unknown> {
  /**
   * Extracts the unique record identity (e.g. trialId). When provided,
   * appendBatch rejects duplicate IDs within the batch and against the
   * existing file (exactly-once persistence).
   */
  readonly idOf?: ((record: T) => string) | undefined;
  /** Lock acquisition timeout in ms (default 5000). */
  readonly lockTimeoutMs?: number | undefined;
}

/**
 * Append-only NDJSON evidence store with durability guarantees (R6 item 8):
 * read, uniqueness check and write happen UNDER A SINGLE interprocess lock
 * (R5 checked before the lock, letting two concurrent writers persist the
 * same ID); each batch loops writeSync to completion plus fsync; torn tails
 * are detected on read with a repair helper.
 */
export class NDJsonStore<T> implements INDJsonStore<T> {
  private readonly schema: ZodType<T>;
  private readonly idOf?: ((record: T) => string) | undefined;
  private readonly lockTimeoutMs: number;

  constructor(schema: ZodType<T>, options: NDJsonStoreOptions<T> = {}) {
    this.schema = schema;
    this.idOf = options.idOf;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  }

  public async append(filePath: string, record: T): Promise<void> {
    await this.appendBatch(filePath, [record]);
  }

  public async appendBatch(filePath: string, records: readonly T[]): Promise<void> {
    if (records.length === 0) return;
    const validated = records.map((record, index) => this.validateRecord(record, `appendBatch[${index}]`));
    this.ensureDirectory(filePath);
    await withFileLock(filePath, this.lockTimeoutMs, () => {
      this.assertNoPartialTailLocked(filePath);
      if (this.idOf) {
        const seen = new Set<string>();
        for (const record of validated) {
          const id = this.idOf(record);
          if (seen.has(id)) {
            throw new ActionableBenchmarkError({
              code: "RESULT_INVALID",
              message: `Duplicate record ID "${id}" within appendBatch. Each attempt must be recorded exactly once.`,
              remediation: "Ensure batch record IDs are unique before appending.",
              retryable: false,
              details: { duplicateId: id },
            });
          }
          seen.add(id);
        }
        const existingIds = this.collectIdsLocked(filePath);
        for (const id of seen) {
          if (existingIds.has(id)) {
            throw new ActionableBenchmarkError({
              code: "RESULT_INVALID",
              message: `Duplicate record ID "${id}" already present in ${filePath}. Each attempt must be recorded exactly once.`,
              remediation: "Do not re-append persisted records; use fresh trial IDs for new attempts.",
              retryable: false,
              details: { duplicateId: id, filePath },
            });
          }
        }
      }
      const payload = Buffer.from(validated.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
      const fd = openSync(filePath, "a");
      try {
        // Loop to completion: short writes must not silently truncate batches.
        let offset = 0;
        while (offset < payload.length) {
          const written = writeSync(fd, payload, offset);
          if (written <= 0) {
            throw new ActionableBenchmarkError({
              code: "RESULT_INVALID",
              message: `Short write persisting batch to ${filePath} (${offset}/${payload.length} bytes).`,
              remediation: "Retry the append; the torn tail detector guards partial visibility.",
              retryable: true,
              details: { filePath, offset, total: payload.length },
            });
          }
          offset += written;
        }
        fsyncSync(fd);
      } finally {
        try {
          closeSync(fd);
        } catch {
          // ignore close errors after fsync
        }
      }
    });
  }

  public async readAll(
    filePath: string,
    options?: NDJsonReadOptions,
  ): Promise<readonly T[]> {
    this.assertNoPartialTail(filePath, options);
    const records: T[] = [];
    for await (const record of this.streamAll(filePath, options)) {
      records.push(record);
    }
    return records;
  }

  public async *streamAll(
    filePath: string,
    options?: NDJsonReadOptions,
  ): AsyncIterable<T> {
    if (!existsSync(filePath)) {
      if (options?.allowMissingFile === true) {
        return;
      }
      throw new ActionableBenchmarkError({
        code: "HARNESS_UNAVAILABLE",
        message: `NDJSON evidence store file not found: ${filePath}`,
        remediation: "Ensure the execution completed and created the evidence file before attempting read.",
        retryable: false,
        details: { filePath },
      });
    }

    const ignoreEmptyLines = options?.ignoreEmptyLines ?? true;
    const maxLineLengthBytes = options?.maxLineLengthBytes ?? 10 * 1024 * 1024; // 10MB safeguard

    const fileStream = createReadStream(filePath, { encoding: "utf8" });
    const readline = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;
    try {
      for await (const line of readline) {
        lineNumber += 1;
        const trimmed = line.trim();

        if (trimmed.length === 0) {
          if (ignoreEmptyLines) {
            continue;
          }
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Empty line encountered at line ${lineNumber} in ${filePath}`,
            remediation: "Remove empty lines or enable ignoreEmptyLines option.",
            retryable: false,
            details: { filePath, lineNumber },
          });
        }

        if (Buffer.byteLength(line, "utf8") > maxLineLengthBytes) {
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Line ${lineNumber} in ${filePath} exceeds maximum length of ${maxLineLengthBytes} bytes`,
            remediation: "Ensure log lines do not contain unbounded payloads.",
            retryable: false,
            details: { filePath, lineNumber, maxLineLengthBytes },
          });
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch (error) {
          const parseMessage = error instanceof Error ? error.message : String(error);
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Malformed JSON at line ${lineNumber} in ${filePath}: ${parseMessage}`,
            remediation: "Ensure all records in the NDJSON store are valid JSON strings.",
            retryable: false,
            details: { filePath, lineNumber, parseError: parseMessage },
          });
        }

        const result = this.schema.safeParse(parsed);
        if (!result.success) {
          const formattedErrors = result.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ");
          throw new ActionableBenchmarkError({
            code: "RESULT_INVALID",
            message: `Schema validation failed at line ${lineNumber} in ${filePath}: ${formattedErrors}`,
            remediation: "Fix data format to match the declared schema.",
            retryable: false,
            details: {
              filePath,
              lineNumber,
              issues: result.error.issues,
            },
          });
        }
        yield result.data;
      }
    } finally {
      readline.close();
      fileStream.destroy();
    }
  }

  /**
   * Detects a torn (partially written) tail: a non-empty file whose last
   * byte is not `\n` indicates a crash between write() and completion.
   * Throws fail-closed; call repairPartialTail() to truncate to the last
   * complete line after triaging the loss.
   */
  public assertNoPartialTail(filePath: string, options?: NDJsonReadOptions): void {
    if (!existsSync(filePath)) {
      if (options?.allowMissingFile === true) return;
      return;
    }
    const st = statSync(filePath);
    if (st.size === 0) return;
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(1);
      readSync(fd, buf, 0, 1, st.size - 1);
      if (buf[0] !== 0x0a) {
        throw new ActionableBenchmarkError({
          code: "RESULT_INVALID",
          message: `Partial (torn) tail detected in ${filePath}: last byte is not a newline. A crash likely interrupted a batch write.`,
          remediation: "Triage the loss, then run repairPartialTail() to truncate to the last complete line and re-run missing attempts with fresh IDs.",
          retryable: false,
          details: { filePath, size: st.size },
        });
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  private assertNoPartialTailLocked(filePath: string): void {
    if (!existsSync(filePath)) return;
    this.assertNoPartialTail(filePath);
  }

  private validateRecord(record: T, context: string): T {
    const result = this.schema.safeParse(record);
    if (!result.success) {
      const formatted = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new ActionableBenchmarkError({
        code: "RESULT_INVALID",
        message: `Cannot serialize record (${context}): schema validation failed: ${formatted}`,
        remediation: "Provide records conforming to the target schema.",
        retryable: false,
        details: { context, issues: result.error.issues },
      });
    }
    return result.data;
  }

  private ensureDirectory(filePath: string): void {
    const parent = dirname(filePath);
    if (!existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }
  }

  private collectIdsLocked(filePath: string): Set<string> {
    const ids = new Set<string>();
    if (!this.idOf || !existsSync(filePath)) return ids;
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        ids.add(this.idOf(JSON.parse(trimmed)));
      } catch {
        // torn tail already rejected above; ignore unidentifiable lines here
      }
    }
    return ids;
  }
}

/**
 * Truncates a torn tail (see assertNoPartialTail) to the last complete
 * `\n`-terminated line. Returns the number of bytes discarded. The loss must
 * be triaged by the caller (re-run the missing attempts with fresh IDs).
 */
export function repairPartialTail(filePath: string): number {
  const raw = readFileSync(filePath);
  if (raw.length === 0) return 0;
  if (raw[raw.length - 1] === 0x0a) return 0;
  const lastNewline = raw.lastIndexOf(0x0a);
  const truncated = lastNewline < 0 ? Buffer.alloc(0) : raw.subarray(0, lastNewline + 1);
  const discarded = raw.length - truncated.length;
  const tmpPath = `${filePath}.repair-tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    let offset = 0;
    while (offset < truncated.length) {
      const written = writeSync(fd, truncated, offset);
      if (written <= 0) break;
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, filePath);
  return discarded;
}
