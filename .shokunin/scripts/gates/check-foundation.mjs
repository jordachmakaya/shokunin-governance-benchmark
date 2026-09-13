#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const checks = [];

function check(id, condition, message, evidence = []) {
  checks.push({ id, verdict: condition ? "PASS" : "FAIL", message, evidence });
}

function readJson(repositoryPath) {
  return JSON.parse(readFileSync(resolve(root, repositoryPath), "utf8"));
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const requiredFiles = [
  ".claude/settings.json",
  ".gemini/settings.json",
  ".shokunin/BENCHMARK_REPO.json",
  ".shokunin/hooks/HOOKS_REGISTRY.json",
  ".shokunin/hooks/harness-adapter.json",
  ".shokunin/systems/ACTIVE_ASSIGNMENTS.json",
  ".shokunin/systems/SYSTEM_REGISTRY.json",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "MEMORY.md",
  "README.md",
  "docs/HYPOTHESES.md",
  "docs/METHODOLOGY.md",
  "docs/PRINCIPLES.md",
  "docs/THREATS_TO_VALIDITY.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "tsconfig.json",
];
const missing = requiredFiles.filter((path) => !existsSync(resolve(root, path)));
check(
  "required-foundation-files",
  missing.length === 0,
  missing.length === 0 ? "All foundation files exist." : `Missing: ${missing.join(", ")}`,
  requiredFiles,
);

let repository;
let hookRegistry;
let adapter;
let systemRegistry;
let assignments;
try {
  repository = readJson(".shokunin/BENCHMARK_REPO.json");
  hookRegistry = readJson(".shokunin/hooks/HOOKS_REGISTRY.json");
  adapter = readJson(".shokunin/hooks/harness-adapter.json");
  systemRegistry = readJson(".shokunin/systems/SYSTEM_REGISTRY.json");
  assignments = readJson(".shokunin/systems/ACTIVE_ASSIGNMENTS.json");
  check("json-registries", true, "All foundation registries are valid JSON.");
} catch (error) {
  check("json-registries", false, `Registry parse failed: ${error.message}`);
}

if (repository && hookRegistry && adapter && systemRegistry && assignments) {
  check(
    "autonomous-marker",
    repository.autonomous === true && repository.repositoryId === "shokunin-benchmarks",
    "Repository autonomy marker is explicit.",
  );

  const handlerPaths = Object.values(hookRegistry.hooks).flat();
  const missingHandlers = handlerPaths.filter(
    (path) => !existsSync(resolve(root, ".shokunin", path)),
  );
  check(
    "registered-handlers",
    missingHandlers.length === 0,
    missingHandlers.length === 0
      ? "Every canonical handler exists."
      : `Missing handlers: ${missingHandlers.join(", ")}`,
    handlerPaths,
  );

  const knownEvents = new Set(Object.keys(hookRegistry.hooks));
  const invalidRoutes = Object.entries(adapter.clients).flatMap(([client, routes]) =>
    routes
      .filter((route) => !knownEvents.has(route.canonicalEvent))
      .map((route) => `${client}:${route.nativeEvent}->${route.canonicalEvent}`),
  );
  check(
    "adapter-routes",
    invalidRoutes.length === 0,
    invalidRoutes.length === 0
      ? "Every native route targets a canonical event."
      : `Invalid routes: ${invalidRoutes.join(", ")}`,
  );

  const roots = systemRegistry.systems.flatMap((system) =>
    system.writeRoots.map((path) => ({ id: system.id, path })),
  );
  const overlaps = [];
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const a = roots[left];
      const b = roots[right];
      if (a.id === b.id) continue;
      if (
        a.path === b.path ||
        a.path.startsWith(`${b.path}/`) ||
        b.path.startsWith(`${a.path}/`)
      ) {
        overlaps.push(`${a.id}:${a.path}<->${b.id}:${b.path}`);
      }
    }
  }
  check(
    "exclusive-system-write-roots",
    overlaps.length === 0,
    overlaps.length === 0
      ? "System write roots are pairwise exclusive."
      : `Overlapping roots: ${overlaps.join(", ")}`,
  );

  const active = assignments.assignments.filter(
    (assignment) => assignment.status === "ACTIVE",
  );
  const allAssignments = assignments.assignments;
  const codex = allAssignments.find((assignment) => assignment.actor === "codex");
  const gemini = allAssignments.find((assignment) => assignment.actor === "gemini");
  const buffy = allAssignments.find((assignment) => assignment.actor === "buffy");
  const isPostG0Parallel =
    active.length === 2 &&
    codex?.status === "ACTIVE" &&
    codex?.zoneId === "ZB2" &&
    codex.writeRoots.length === 1 &&
    codex.writeRoots[0] === "packages/benchmark-kit" &&
    gemini?.status === "ACTIVE" &&
    gemini?.zoneId === "ZB1" &&
    gemini.writeRoots.length === 1 &&
    gemini.writeRoots[0] === "packages/core" &&
    codex.writeFiles.length === 0 &&
    gemini.writeFiles.length === 0;

  const isZb2Active =
    active.length === 1 &&
    gemini?.status === "ACTIVE" &&
    gemini?.zoneId === "ZB2" &&
    gemini.writeRoots.length === 1 &&
    gemini.writeRoots[0] === "packages/benchmark-kit" &&
    gemini.writeFiles.length === 0 &&
    codex?.status === "REVIEW_ONLY" &&
    codex.writeRoots.length === 0;

  const isZ5SourceSelection =
    active.length === 0 &&
    assignments.phase === "P2A_Z5_SOURCE_SELECTION" &&
    assignments.gateRequiredForParallelWork === "G2_CORE_RUNTIME_INTEGRATED" &&
    assignments.sharedFileOwner === "codex" &&
    repository.gate === "G2_CORE_RUNTIME_INTEGRATED" &&
    repository.gateStatus === "PASS" &&
    ["ZB0", "ZB1", "ZB2"].every((zone) =>
      assignments.sealedZones.includes(zone) && repository.sealedZones.includes(zone)
    ) &&
    allAssignments.every(
      (assignment) =>
        assignment.status === "REVIEW_ONLY" &&
        assignment.zoneId === null &&
        assignment.writeRoots.length === 0 &&
        assignment.writeFiles.length === 0,
    );

  const z5CopyRoots = [
    "benchmarks/execution-zone/hypotheses",
    "benchmarks/execution-zone/experiments",
    "benchmarks/execution-zone/source-snapshots",
    "benchmarks/execution-zone/manifests",
  ];
  const z5System = systemRegistry.systems.find((system) => system.id === "ZB5");
  const g2aSealPath = ".shokunin/gates/G2A_Z5_SOURCE_SELECTION_FROZEN.seal.json";
  const g2aSeal = existsSync(resolve(root, g2aSealPath))
    ? readJson(g2aSealPath)
    : null;
  const isZ5ControlledCopy =
    active.length === 1 &&
    assignments.phase === "P2B_Z5_CONTROLLED_COPY" &&
    assignments.gateRequiredForParallelWork ===
      "G2A_Z5_SOURCE_SELECTION_FROZEN" &&
    assignments.sharedFileOwner === "codex" &&
    repository.gate === "G2A_Z5_SOURCE_SELECTION_FROZEN" &&
    repository.gateStatus === "PASS" &&
    repository.sourceFreezeCommit ===
      "f59fd00ab2e5aa3e4d582bb3a0e44b73956c1b81" &&
    g2aSeal?.verdict === "PASS" &&
    g2aSeal?.source?.commit === repository.sourceFreezeCommit &&
    ["ZB0", "ZB1", "ZB2"].every(
      (zone) =>
        assignments.sealedZones.includes(zone) &&
        repository.sealedZones.includes(zone),
    ) &&
    z5System?.dependsOn?.length === 1 &&
    z5System.dependsOn[0] === "G2A_Z5_SOURCE_SELECTION_FROZEN" &&
    z5System.writeRoots.length === z5CopyRoots.length &&
    z5CopyRoots.every((writeRoot) => z5System.writeRoots.includes(writeRoot)) &&
    buffy?.status === "ACTIVE" &&
    buffy?.model === "mimo-v2.5" &&
    buffy?.zoneId === "ZB5" &&
    buffy.writeRoots.length === z5CopyRoots.length &&
    z5CopyRoots.every((writeRoot) => buffy.writeRoots.includes(writeRoot)) &&
    buffy.writeFiles.length === 0 &&
    allAssignments
      .filter((assignment) => assignment.actor !== "buffy")
      .every(
        (assignment) =>
          assignment.status === "REVIEW_ONLY" &&
          assignment.zoneId === null &&
          assignment.writeRoots.length === 0 &&
          assignment.writeFiles.length === 0,
      );

  const isPostG2bEvalBuild =
    active.length === 1 &&
    assignments.phase === "P2C_ZB3_EVALS_AND_ZB5_H1_DEFINITIONS" &&
    assignments.gateRequiredForParallelWork === "G2B_Z5_COPY_VERIFIED" &&
    assignments.sharedFileOwner === "codex" &&
    repository.gate === "G2B_Z5_COPY_VERIFIED" &&
    repository.gateStatus === "PASS" &&
    repository.sealedZones.includes("ZB5_COPY_VERIFIED") &&
    codex?.status === "ACTIVE" &&
    codex?.model === "codex" &&
    codex?.zoneId === "ZB3" &&
    codex.writeRoots.length === 1 &&
    codex.writeRoots[0] === "packages/evals" &&
    codex.writeFiles.length === 0 &&
    allAssignments
      .filter((assignment) => assignment.actor !== "codex")
      .every(
        (assignment) =>
          assignment.status === "REVIEW_ONLY" &&
          assignment.zoneId === null &&
          assignment.writeRoots.length === 0 &&
          assignment.writeFiles.length === 0,
      );

  const isPostG2bZ5Definitions =
    active.length === 1 &&
    assignments.phase === "P2C_ZB5_H1_DEFINITIONS" &&
    assignments.gateRequiredForParallelWork === "G2B_Z5_COPY_VERIFIED" &&
    repository.gate === "G2B_Z5_COPY_VERIFIED" &&
    repository.gateStatus === "PASS" &&
    codex?.status === "ACTIVE" &&
    codex?.zoneId === "ZB5" &&
    codex.writeRoots.length === 2 &&
    codex.writeRoots.includes("benchmarks/execution-zone/hypotheses") &&
    codex.writeRoots.includes("benchmarks/execution-zone/experiments") &&
    codex.writeFiles.length === 0 &&
    allAssignments
      .filter((assignment) => assignment.actor !== "codex")
      .every((assignment) => assignment.status === "REVIEW_ONLY" && assignment.zoneId === null && assignment.writeRoots.length === 0 && assignment.writeFiles.length === 0);

  const isZb6CliBuild =
    active.length === 1 && assignments.phase === "P2D_ZB6_CLI" &&
    assignments.gateRequiredForParallelWork === "G2B_Z5_COPY_VERIFIED" &&
    repository.gate === "G2B_Z5_COPY_VERIFIED" && repository.gateStatus === "PASS" &&
    codex?.status === "ACTIVE" && codex?.zoneId === "ZB6" &&
    codex.writeRoots.length === 1 && codex.writeRoots[0] === "apps/benchmark-cli" &&
    codex.writeFiles.length === 0 &&
    allAssignments.filter((assignment) => assignment.actor !== "codex").every((assignment) => assignment.status === "REVIEW_ONLY" && assignment.zoneId === null && assignment.writeRoots.length === 0 && assignment.writeFiles.length === 0);

  const isH1PilotReady =
    active.length === 1 &&
    assignments.phase === "P3_H1_PILOT_READY" &&
    assignments.gateRequiredForParallelWork === "G4_PUBLIC_API_STABLE" &&
    repository.gate === "G4_PUBLIC_API_STABLE" &&
    repository.gateStatus === "PASS" &&
    ["ZB0", "ZB1", "ZB2", "ZB3", "ZB5_COPY_VERIFIED", "ZB6"].every((zone) =>
      assignments.sealedZones.includes(zone) && repository.sealedZones.includes(zone),
    ) &&
    codex?.status === "ACTIVE" &&
    codex?.zoneId === "ZB6" &&
    codex.writeRoots.length === 1 &&
    codex.writeRoots[0] === "apps/benchmark-cli" &&
    codex.writeFiles.length === 0 &&
    allAssignments.filter((assignment) => assignment.actor !== "codex").every((assignment) =>
      assignment.status === "REVIEW_ONLY" && assignment.zoneId === null && assignment.writeRoots.length === 0 && assignment.writeFiles.length === 0,
    );

  check(
    "post-g0-assignment-transfer",
    repository.gateStatus === "PASS" &&
      (isPostG0Parallel ||
        isZb2Active ||
        isZ5SourceSelection ||
        isZ5ControlledCopy ||
        isPostG2bEvalBuild ||
        isPostG2bZ5Definitions ||
        isZb6CliBuild ||
        isH1PilotReady),
    "Sealed gates and active/review-only assignments form an allowed exclusive phase.",
  );
}

const typedFiles = [
  ...walk(resolve(root, "packages")),
  ...walk(resolve(root, ".shokunin/hooks/contracts")),
].filter((path) => extname(path) === ".ts");
const explicitAny = typedFiles.flatMap((path) => {
  const lines = readFileSync(path, "utf8").split("\n");
  return lines.flatMap((line, index) =>
    /:\s*any\b|<\s*any\s*>/.test(line) ? [`${path}:${index + 1}`] : [],
  );
});
check(
  "no-explicit-any",
  explicitAny.length === 0,
  explicitAny.length === 0
    ? "Public contracts and schemas contain no explicit any."
    : `Explicit any found: ${explicitAny.join(", ")}`,
);

const treatmentHooks = walk(resolve(root, "benchmarks")).filter((path) =>
  path.includes("/.shokunin/hooks/"),
);
check(
  "no-treatment-hook-contamination",
  treatmentHooks.length === 0,
  treatmentHooks.length === 0
    ? "No development hook is installed inside the treatment plane."
    : `Treatment-plane hooks found: ${treatmentHooks.join(", ")}`,
);

const verdict = checks.every((item) => item.verdict === "PASS") ? "PASS" : "FAIL";
process.stdout.write(
  `${JSON.stringify({ gateId: "G0_FOUNDATION_FROZEN", verdict, checks }, null, 2)}\n`,
);
process.exitCode = verdict === "PASS" ? 0 : 1;
