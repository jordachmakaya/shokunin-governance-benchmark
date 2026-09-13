import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  managedMarker,
  materializeClient,
} from "../../scripts/hook-materializers/materializer-lib.mjs";

function commands(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => commands(item, result));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => commands(item, result));
  }
  return result;
}

for (const client of ["claude-code", "gemini", "codex"]) {
  test(`${client} materialization preserves unrelated hooks and is idempotent`, () => {
    const directory = mkdtempSync(resolve(tmpdir(), `benchmark-${client}-`));
    try {
      const target = resolve(directory, "hooks.json");
      writeFileSync(
        target,
        JSON.stringify({
          custom: true,
          hooks: {
            PreToolUse: [
              {
                matcher: "Read",
                hooks: [{ type: "command", command: "unrelated-command", timeout: 3 }],
              },
            ],
          },
        }),
      );
      materializeClient({ client, target });
      const first = readFileSync(target, "utf8");
      materializeClient({ client, target });
      const second = readFileSync(target, "utf8");
      assert.equal(second, first);
      const parsed = JSON.parse(second);
      assert.equal(parsed.custom, true);
      const allCommands = commands(parsed);
      assert.ok(allCommands.includes("unrelated-command"));
      assert.ok(allCommands.some((command) => command.includes(managedMarker())));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("generated global command exits successfully outside benchmark repositories", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "benchmark-command-"));
  const outside = mkdtempSync(resolve(tmpdir(), "benchmark-command-outside-"));
  try {
    const target = resolve(directory, "hooks.json");
    const { config } = materializeClient({ client: "codex", target });
    const command = config.hooks.PreToolUse
      .flatMap((group) => group.hooks)
      .find((hook) => hook.command.includes(managedMarker())).command;
    const result = spawnSync("sh", ["-c", command], {
      cwd: outside,
      input: "{}",
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
