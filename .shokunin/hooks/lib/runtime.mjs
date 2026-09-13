import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function findProjectRoot(startDirectory = process.cwd()) {
  let candidate = resolve(startDirectory);
  while (true) {
    if (existsSync(resolve(candidate, ".shokunin/BENCHMARK_REPO.json"))) {
      return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readJsonStdin() {
  if (process.env.SHOKUNIN_HOOK_PAYLOAD_BASE64) {
    const decoded = Buffer.from(
      process.env.SHOKUNIN_HOOK_PAYLOAD_BASE64,
      "base64",
    ).toString("utf8");
    return JSON.parse(decoded);
  }
  let raw = "";
  try {
    raw = readFileSync(0, "utf8").trim();
  } catch {
    return {};
  }
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Hook input must be a JSON object.");
  }
}

export function emit(verdict) {
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

export function deny(code, message, remediation, details = {}) {
  emit({ verdict: "BLOCK", error: { code, message, remediation, details } });
  process.exitCode = 1;
}

export function allow(message, details = {}) {
  emit({ verdict: "ALLOW", message, details });
}

export function getTool(payload) {
  const toolName = String(
    payload.tool_name ?? payload.toolName ?? payload.name ?? payload.tool ?? "",
  );
  const input = payload.tool_input ?? payload.input ?? payload.arguments ?? {};
  return {
    toolName,
    input: input && typeof input === "object" ? input : {},
  };
}

const WRITE_TOOL = /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch|write_file|replace)$/i;
const SHELL_TOOL = /^(Bash|Shell|run_shell_command|exec_command)$/i;
const MUTATING_SHELL = /(^|[;&|]\s*)(cp|mv|rm|mkdir|touch|install|chmod|chown|ln|tee|truncate|patch|git\s+(add|commit|checkout|switch|restore|reset|clean)|pnpm\s+(add|install)|npm\s+(install|i)|yarn\s+add)\b|(^|\s)(sed|perl)\s+-[^\n]*i|(^|[^<])>{1,2}(?!>)/im;

function collectStrings(value, result = []) {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, result);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, result);
  }
  return result;
}

function extractPatchPaths(text) {
  return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
    (match) => match[1].trim(),
  );
}

function extractExplicitPaths(input) {
  const paths = [];
  for (const key of [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "notebook_path",
  ]) {
    if (typeof input[key] === "string") paths.push(input[key]);
  }
  return paths;
}

export function inspectAction(payload) {
  const { toolName, input } = getTool(payload);
  const strings = collectStrings(input);
  const patchPaths = strings.flatMap(extractPatchPaths);
  const explicitPaths = extractExplicitPaths(input);
  const isWriteTool = WRITE_TOOL.test(toolName);
  const isShell = SHELL_TOOL.test(toolName);
  const shellText = isShell ? strings.join("\n") : "";
  const isMutatingShell = isShell && MUTATING_SHELL.test(shellText);
  return {
    toolName,
    input,
    isWrite: isWriteTool || isMutatingShell,
    ambiguousShellWrite: isMutatingShell,
    paths: [...new Set([...explicitPaths, ...patchPaths])],
    searchableText: strings.join("\n"),
  };
}

const PUBLIC_SECRET_PATTERN =
  /(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|HARBOR|AWS|GITHUB)_[A-Z0-9_]*(?:KEY|TOKEN|SECRET)\s*=|(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|\/private\/|raw[-_ ]?(?:trial|output|transcript)/i;

export function containsPublicSecretRisk(text) {
  return PUBLIC_SECRET_PATTERN.test(text);
}

export function normalizeRepositoryPath(root, candidate) {
  const absolute = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(root, candidate.replace(/^\.\//, ""));
  const repositoryRelative = relative(root, absolute);
  if (
    repositoryRelative === "" ||
    repositoryRelative === ".." ||
    repositoryRelative.startsWith(`..${sep}`) ||
    isAbsolute(repositoryRelative)
  ) {
    return null;
  }
  return repositoryRelative.split(sep).join("/");
}

export function assignmentFor(root, actor) {
  const registry = readJson(resolve(root, ".shokunin/systems/ACTIVE_ASSIGNMENTS.json"));
  return registry.assignments.find((assignment) => assignment.actor === actor) ?? null;
}

export function pathIsAllowed(assignment, repositoryPath) {
  if (assignment.writeFiles.includes(repositoryPath)) return true;
  return assignment.writeRoots.some(
    (writeRoot) =>
      repositoryPath === writeRoot || repositoryPath.startsWith(`${writeRoot}/`),
  );
}

export function appendNdjson(path, record) {
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
}
