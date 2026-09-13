import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function walkFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...walkFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

test("RULE 7: benchmark-kit must never import from packages/core/src/**", () => {
  const tsFiles = walkFiles(packageRoot).filter(
    (file) => extname(file) === ".ts",
  );

  const violations: string[] = [];
  const bannedPattern = /(?:from\s+['"][^'"]*packages\/core\/src|from\s+['"]@shokunin\/core\/src)/;

  for (const file of tsFiles) {
    const content = readFileSync(file, "utf8");
    if (bannedPattern.test(content)) {
      violations.push(file);
    }
  }

  assert.equal(
    violations.length,
    0,
    `Found forbidden imports from packages/core/src in: ${violations.join(", ")}`,
  );
});

test("RULE 6: zero development hook contamination in fixtures or benchmark-kit", () => {
  const allFiles = walkFiles(packageRoot);
  const hookContaminations = allFiles.filter(
    (file) => file.includes(".shokunin/hooks") || file.includes(".shokunin\\hooks"),
  );

  assert.equal(
    hookContaminations.length,
    0,
    `Found hook contamination in benchmark-kit: ${hookContaminations.join(", ")}`,
  );
});

test("Harbor fixtures contain no live credential patterns", () => {
  const fixtureDir = join(packageRoot, "tests", "fixtures");
  const fixtureFiles = walkFiles(fixtureDir);

  const liveSecretPattern = /(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}/;
  const suspiciousFiles: string[] = [];

  for (const file of fixtureFiles) {
    const content = readFileSync(file, "utf8");
    if (liveSecretPattern.test(content)) {
      suspiciousFiles.push(file);
    }
  }

  assert.equal(
    suspiciousFiles.length,
    0,
    `Found live secret patterns in fixtures: ${suspiciousFiles.join(", ")}`,
  );
});
