import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { ActionableBenchmarkError } from "../src/errors/actionable-error.js";
import { NDJsonStore } from "../src/persistence/ndjson-store.js";

const recordSchema = z.object({
  id: z.string().min(1),
  count: z.number().int().nonnegative(),
});

type RecordType = z.infer<typeof recordSchema>;

test("BLOCKER 4: NDJsonStore rejects missing file fail-closed with ActionableBenchmarkError", async () => {
  const store = new NDJsonStore<RecordType>(recordSchema);
  const nonExistentPath = join(tmpdir(), "non_existent_evidence_file_12345.ndjson");

  await assert.rejects(
    async () => {
      await store.readAll(nonExistentPath);
    },
    (err: unknown) => {
      assert.ok(err instanceof ActionableBenchmarkError);
      assert.equal(err.code, "HARNESS_UNAVAILABLE");
      assert.ok(err.message.includes("not found"));
      return true;
    },
  );

  // Missing file is only tolerated if explicitly allowed
  const emptyIfAllowed = await store.readAll(nonExistentPath, { allowMissingFile: true });
  assert.deepEqual(emptyIfAllowed, []);
});

test("BLOCKER 4: NDJsonStore rejects appending records that do not conform to schema", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ndjson-append-fail-"));
  const filePath = join(tempDir, "invalid-append.ndjson");

  try {
    const store = new NDJsonStore<RecordType>(recordSchema);

    // Invalid: count is negative and id is empty
    await assert.rejects(
      async () => {
        await store.append(filePath, { id: "", count: -99 } as unknown as RecordType);
      },
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.ok(err.message.includes("schema validation failed"));
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NDJsonStore appends and reads records accurately", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ndjson-test-"));
  const filePath = join(tempDir, "data.ndjson");

  try {
    const store = new NDJsonStore<RecordType>(recordSchema);
    await store.append(filePath, { id: "rec-1", count: 10 });
    await store.appendBatch(filePath, [
      { id: "rec-2", count: 20 },
      { id: "rec-3", count: 30 },
    ]);

    const all = await store.readAll(filePath);
    assert.equal(all.length, 3);
    assert.deepEqual(all[0], { id: "rec-1", count: 10 });
    assert.deepEqual(all[1], { id: "rec-2", count: 20 });
    assert.deepEqual(all[2], { id: "rec-3", count: 30 });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NDJsonStore streams records line by line asynchronously", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ndjson-stream-"));
  const filePath = join(tempDir, "stream.ndjson");

  try {
    const store = new NDJsonStore<RecordType>(recordSchema);
    const items = [
      { id: "s-1", count: 1 },
      { id: "s-2", count: 2 },
      { id: "s-3", count: 3 },
    ];
    await store.appendBatch(filePath, items);

    const streamed: RecordType[] = [];
    for await (const record of store.streamAll(filePath)) {
      streamed.push(record);
    }
    assert.deepEqual(streamed, items);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NDJsonStore rejects malformed JSON fail-closed with ActionableBenchmarkError", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ndjson-corrupt-"));
  const filePath = join(tempDir, "corrupt.ndjson");

  try {
    writeFileSync(
      filePath,
      '{"id": "ok-1", "count": 1}\n{CORRUPTED_JSON_NOT_VALID}\n{"id": "ok-2", "count": 2}\n',
      "utf8",
    );

    const store = new NDJsonStore<RecordType>(recordSchema);

    await assert.rejects(
      async () => {
        await store.readAll(filePath);
      },
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.ok(err.message.includes("line 2"));
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("NDJsonStore rejects records failing schema validation fail-closed during read", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "ndjson-schema-fail-"));
  const filePath = join(tempDir, "schema-fail.ndjson");

  try {
    writeFileSync(
      filePath,
      '{"id": "ok-1", "count": 1}\n{"id": "", "count": -5}\n',
      "utf8",
    );

    const store = new NDJsonStore<RecordType>(recordSchema);

    await assert.rejects(
      async () => {
        await store.readAll(filePath);
      },
      (err: unknown) => {
        assert.ok(err instanceof ActionableBenchmarkError);
        assert.equal(err.code, "RESULT_INVALID");
        assert.ok(err.message.includes("line 2"));
        return true;
      },
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
