#!/usr/bin/env node
import { basename } from "node:path";
import { materializeClient } from "./materializer-lib.mjs";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const inferredClients = {
  "materialize-claude.mjs": "claude-code",
  "materialize-gemini.mjs": "gemini",
  "materialize-codex.mjs": "codex",
};
const client = argument("--client") ?? inferredClients[basename(process.argv[1] ?? "")];
if (!client) {
  process.stderr.write("materialize-client requires --client.\n");
  process.exit(2);
}
const result = materializeClient({
  client,
  target: argument("--target") ?? undefined,
  dryRun: process.argv.includes("--check"),
});
process.stdout.write(
  `${JSON.stringify({ status: "PASS", client, target: result.target })}\n`,
);
