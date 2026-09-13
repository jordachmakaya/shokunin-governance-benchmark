import { resolve } from "node:path";
import { allow, appendNdjson, readJsonStdin } from "../../lib/runtime.mjs";

const root = process.env.SHOKUNIN_BENCHMARK_ROOT;
const actor = process.env.SHOKUNIN_ACTOR;
if (!root || !actor) throw new Error("Missing hook runtime context.");

const payload = readJsonStdin();
appendNdjson(resolve(root, ".shokunin/run/session-state.ndjson"), {
  recordedAt: new Date().toISOString(),
  plane: "development",
  actor,
  event: process.env.SHOKUNIN_CANONICAL_EVENT,
  sessionId: String(payload.session_id ?? payload.sessionId ?? "unknown"),
});
allow("Sanitized session state recorded.");
