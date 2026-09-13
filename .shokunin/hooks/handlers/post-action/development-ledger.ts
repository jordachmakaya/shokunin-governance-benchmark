import { resolve } from "node:path";
import {
  allow,
  appendNdjson,
  getTool,
  readJsonStdin,
} from "../../lib/runtime.mjs";

const root = process.env.SHOKUNIN_BENCHMARK_ROOT;
const actor = process.env.SHOKUNIN_ACTOR;
if (!root || !actor) throw new Error("Missing hook runtime context.");

const { toolName } = getTool(readJsonStdin());
appendNdjson(resolve(root, ".shokunin/run/development-events.ndjson"), {
  recordedAt: new Date().toISOString(),
  plane: "development",
  event: process.env.SHOKUNIN_CANONICAL_EVENT,
  actor,
  tool: toolName,
});
allow("Sanitized development event recorded.");
