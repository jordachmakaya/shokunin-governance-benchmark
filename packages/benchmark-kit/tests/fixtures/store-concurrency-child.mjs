// Concurrency probe child (R6 item 8): appends the FIXED record
// {id:"same-attempt"} to the NDJSON file given as argv[2].
// Exit 0 when persisted, 1 when rejected as duplicate (exactly-once).
import { NDJsonStore } from "../../dist/src/persistence/ndjson-store.js";
import { z } from "zod";

const filePath = process.argv[2];
if (!filePath) {
  console.error("usage: store-concurrency-child.mjs <ndjson-path>");
  process.exit(2);
}

const recordSchema = z.object({ id: z.string().min(1), value: z.number() });
const store = new NDJsonStore(recordSchema, { idOf: (r) => r.id });
try {
  await store.appendBatch(filePath, [{ id: "same-attempt", value: 1 }]);
  process.exit(0);
} catch {
  process.exit(1);
}
