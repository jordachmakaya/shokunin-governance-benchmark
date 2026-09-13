#!/usr/bin/env node
import { resolve } from "node:path";
import {
  allow,
  findProjectRoot,
  readJson,
  readJsonStdin,
} from "../lib/runtime.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const event = argument("--event");
const actor = argument("--actor");
const root = findProjectRoot();

if (root === null) process.exit(0);
if (event === null || actor === null) {
  process.stderr.write("run-event requires --event and --actor.\n");
  process.exit(2);
}

let payload;
try {
  payload = readJsonStdin();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}

const registry = readJson(resolve(root, ".shokunin/hooks/HOOKS_REGISTRY.json"));
const handlers = registry.hooks[event];
const policy = registry.policies[event];
if (!Array.isArray(handlers) || policy === undefined) {
  process.stderr.write(`Unknown canonical hook event: ${event}\n`);
  process.exit(2);
}

for (const handler of handlers) {
  process.env.SHOKUNIN_BENCHMARK_ROOT = root;
  process.env.SHOKUNIN_CANONICAL_EVENT = event;
  process.env.SHOKUNIN_ACTOR = actor;
  process.env.SHOKUNIN_HOOK_PAYLOAD_BASE64 = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  ).toString("base64");
  process.exitCode = 0;
  let diagnostic = "";
  try {
    await import(`${new URL(resolve(root, ".shokunin", handler), "file:").href}?event=${Date.now()}`);
  } catch (error) {
    diagnostic = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  }

  const failed = process.exitCode !== 0;
  if (!failed) continue;
  if (policy.failurePolicy === "fail-closed") {
    if (diagnostic) process.stderr.write(`${diagnostic}\n`);
    process.exitCode = 1;
    break;
  }
  if (diagnostic) process.stderr.write(`[fail-open ${handler}] ${diagnostic}\n`);
  process.exitCode = 0;
}

if (process.exitCode === 0) {
  allow(`Canonical event ${event} completed.`, { actor });
}
