import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  containsPublicSecretRisk,
  inspectAction,
  normalizeRepositoryPath,
} from "../lib/runtime.mjs";

const root = resolve(new URL("../../../", import.meta.url).pathname);
const runner = resolve(root, ".shokunin/hooks/runners/run-event.mjs");

function run(payload, actor = "codex") {
  return spawnSync(
    process.execPath,
    [runner, "--event", "repo:pre-action", "--actor", actor],
    {
      cwd: root,
      env: {
        ...process.env,
        SHOKUNIN_HOOK_PAYLOAD_BASE64: Buffer.from(
          JSON.stringify(payload),
          "utf8",
        ).toString("base64"),
      },
      encoding: "utf8",
    },
  );
}

test("global dispatcher no-ops outside an autonomous benchmark repository", () => {
  const outside = mkdtempSync(resolve(tmpdir(), "benchmark-hook-outside-"));
  try {
    const result = spawnSync(
      process.execPath,
      [runner, "--event", "repo:pre-action", "--actor", "codex"],
      { cwd: outside, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("Gemini is blocked from sealed ZB2 after G2", () => {
  const result = run(
    {
      tool_name: "write_file",
      tool_input: { file_path: "packages/benchmark-kit/src/example.ts" },
    },
    "gemini",
  );
  assert.notEqual(result.status, 0);
});

test("Gemini is blocked from sealed ZB1 root", () => {
  const result = run(
    { tool_name: "write_file", tool_input: { file_path: "packages/core/src/escape.ts" } },
    "gemini",
  );
  assert.notEqual(result.status, 0);
});

test("Codex active ZB3 is blocked from writing ZB2", () => {
  const result = run(
    {
      tool_name: "apply_patch",
      tool_input: { patch: "*** Add File: packages/benchmark-kit/src/escape.ts\n+no" },
    },
    "codex",
  );
  assert.notEqual(result.status, 0);
});

test("Codex active ZB3 is blocked from writing ZB1", () => {
  const result = run(
    {
      tool_name: "apply_patch",
      tool_input: { patch: "*** Add File: packages/core/src/escape.ts\n+no" },
    },
    "codex",
  );
  assert.notEqual(result.status, 0);
});

test("Codex active actor is allowed only in the active registered root", () => {
  const allowed = [
    "apps/benchmark-cli/src/index.ts",
  ];
  for (const filePath of allowed) {
    const result = run(
      { tool_name: "write_file", tool_input: { file_path: filePath } },
      "codex",
    );
    assert.equal(result.status, 0, `${filePath}: ${result.stderr}`);
  }
});

test("Mimo actor buffy is blocked while review-only", () => {
  const result = run(
    {
      tool_name: "write_file",
      tool_input: { file_path: "benchmarks/execution-zone/hypotheses/H1.md" },
    },
    "buffy",
  );
  assert.notEqual(result.status, 0);
});


test("ambiguous mutating shell commands fail closed", () => {
  const result = run({
    tool_name: "Bash",
    tool_input: { command: "touch docs/ambiguous.md" },
  });
  assert.notEqual(result.status, 0);
});

test("public-secret policy detects credential-like public content", () => {
  const action = inspectAction({
    tool_name: "Write",
    tool_input: {
      file_path: "public/result.json",
      content: "OPENAI_API_KEY=sk_example_not_a_real_secret",
    },
  });
  const targets = action.paths.map((path) => normalizeRepositoryPath(root, path));
  assert.deepEqual(targets, ["public/result.json"]);
  assert.equal(containsPublicSecretRisk(action.searchableText), true);
});

test("zone-seal route runs the mechanical foundation gate", () => {
  const result = spawnSync(
    process.execPath,
    [runner, "--event", "repo:zone-seal", "--actor", "codex"],
    {
      cwd: root,
      env: {
        ...process.env,
        SHOKUNIN_HOOK_PAYLOAD_BASE64: Buffer.from("{}", "utf8").toString(
          "base64",
        ),
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
