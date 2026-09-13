import type { SessionLedgerEvent } from "../../contracts/ledger.contract.js";
import { sessionLedgerEventSchema } from "../../schemas/ledger.schema.js";
import { withFileLock } from "./file-lock.js";
import { createReadStream, existsSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { createInterface } from "node:readline";

/**
 * @fileoverview Durable session ledger (R6 item 7).
 *
 * Every session appends a job-scoped STARTED entry under lock BEFORE spawning
 * any execution; every trial appends its terminal transition after its record
 * is durably persisted. A STARTED entry without matching terminals proves a
 * crash or attrition instead of silently losing attempts.
 */
export class SessionLedger {
  constructor(private readonly lockTimeoutMs: number = 5000) {}

  async append(ledgerPath: string, event: SessionLedgerEvent): Promise<void> {
    const validated = sessionLedgerEventSchema.parse(event) as SessionLedgerEvent;
    await withFileLock(ledgerPath, this.lockTimeoutMs, async () => {
      await appendFile(ledgerPath, `${JSON.stringify(validated)}\n`, "utf8");
    });
  }

  async readAll(ledgerPath: string): Promise<readonly SessionLedgerEvent[]> {
    const events: SessionLedgerEvent[] = [];
    if (!existsSync(ledgerPath)) return events;
    const stream = createReadStream(ledgerPath, { encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        events.push(sessionLedgerEventSchema.parse(JSON.parse(trimmed)) as SessionLedgerEvent);
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return events;
  }
}
