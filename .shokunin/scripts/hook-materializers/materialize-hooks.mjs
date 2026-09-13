#!/usr/bin/env node
import { materializeClient } from "./materializer-lib.mjs";

const apply = process.argv.includes("--apply");
const check = process.argv.includes("--check");
if (apply === check) {
  process.stderr.write("Choose exactly one of --apply or --check.\n");
  process.exit(2);
}

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
const clients = only ? [only] : ["claude-code", "gemini", "codex"];
const results = clients.map((client) =>
  materializeClient({ client, dryRun: check }),
);
process.stdout.write(
  `${JSON.stringify({ status: "PASS", mode: apply ? "apply" : "check", clients: results.map(({ client, target }) => ({ client, target })) })}\n`,
);
