import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TASK_SPECS, evaluateCheck, gateInputFor, parseTrialArgument } from "./h1-executor.mjs";

function withSnapshot(runPy, fn) {
  const root = mkdtempSync(join(tmpdir(), "h1-executor-test-"));
  mkdirSync(join(root, "app"));
  writeFileSync(join(root, "app", "run.py"), runPy, "utf8");
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("trial input fails closed without a frozen per-task digest", () => {
  const payload = {
    campaignId: "H1-pilot-001", experimentId: "H1-completion-verification-001",
    taskId: "cancel-async-tasks", arm: "A1_observing", repetitionIndex: 0,
    attestationNonce: "a".repeat(64),
    runtime: { runtimeId: "codex", runtimeVersion: "0.154.0", model: "openai/gpt-5-mini", containerDigests: {} },
  };
  assert.throws(() => parseTrialArgument(["--trial-json", JSON.stringify(payload)]), /missing the OCI digest/);
});

test("every frozen task has a non-empty public check set and explicit export surface", () => {
  assert.equal(Object.keys(TASK_SPECS).length, 10);
  for (const [taskId, spec] of Object.entries(TASK_SPECS)) {
    assert.ok(spec.checks.length > 0, taskId);
    assert.ok(spec.exportPaths.length > 0, taskId);
    assert.ok(spec.exportPaths.every((path) => path.startsWith("/") && path !== "/solution"), taskId);
    assert.equal(gateInputFor(taskId).declaredChecks.length, spec.checks.length);
  }
});

test("cancel gate accepts bounded concurrency with cancellation cleanup", async () => {
  await withSnapshot(`
import asyncio
async def run_tasks(tasks, max_concurrent):
    pending = list(tasks)
    children = set()
    async def start_batch():
        while pending and len(children) < max_concurrent:
            child = asyncio.create_task(pending.pop(0)())
            children.add(child)
    await start_batch()
    try:
        while children:
            done, children = await asyncio.wait(children, return_when=asyncio.FIRST_COMPLETED)
            for child in done: await child
            await start_batch()
    except asyncio.CancelledError:
        for child in children: child.cancel()
        await asyncio.gather(*children, return_exceptions=True)
        while pending:
            batch = [asyncio.create_task(pending.pop(0)()) for _ in range(min(max_concurrent, len(pending)))]
            await asyncio.sleep(0)
            for child in batch: child.cancel()
            await asyncio.gather(*batch, return_exceptions=True)
        raise
`, async (root) => {
    assert.match(await evaluateCheck("cancel-contract", root, 5000), /contract passed/);
  });
});

test("cancel gate rejects leaked running tasks", async () => {
  await withSnapshot(`
import asyncio
async def run_tasks(tasks, max_concurrent):
    for factory in tasks:
        asyncio.create_task(factory())
    await asyncio.Event().wait()
`, async (root) => {
    await assert.rejects(() => evaluateCheck("cancel-contract", root, 5000));
  });
});

test("WAL gate enforces the complete public 11-row sorted contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "h1-executor-test-"));
  try {
    mkdirSync(join(root, "app"));
    const rows = Array.from({ length: 11 }, (_, index) => ({ id: index + 1, name: `item${index + 1}`, value: index * 3 }));
    writeFileSync(join(root, "app", "recovered.json"), JSON.stringify(rows));
    assert.match(await evaluateCheck("wal-json-contract", root, 5000), /all 11/);
    rows.reverse();
    writeFileSync(join(root, "app", "recovered.json"), JSON.stringify(rows));
    await assert.rejects(() => evaluateCheck("wal-json-contract", root, 5000));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
