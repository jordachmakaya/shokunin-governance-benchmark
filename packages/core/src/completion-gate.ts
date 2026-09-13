import { constants } from "node:os";
import type {
  DeclaredCheck,
  GateCheckResult,
  GateEvaluationInput,
  GateEvaluationResult,
  ICompletionGate,
} from "../contracts/gate.contract.js";
import type {
  CommandExecutionResult,
  ICommandExecutor,
} from "../contracts/executor.contract.js";
import { createActionableError } from "./errors.js";

export interface ParsedCheckCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export type CommandParser = (check: DeclaredCheck) => ParsedCheckCommand;

const SENSITIVE_KEYWORD_FRAGMENT =
  "(?:API_KEY|TOKEN|SECRET|SECRET_KEY|PASSWORD|PASSWD|PRIVATE_KEY)";

// Multiline PEM private key pattern covering PKCS#8, PKCS#1 (RSA), SEC1 (EC), OPENSSH, DSA, PGP, and custom types
const PEM_PRIVATE_KEY_PATTERN =
  /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY(?: BLOCK)?-----/gi;

// Database connection strings containing credentials
const DATABASE_URL_PATTERN =
  /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi;

// Token-like prefixes (sk_..., ghp_..., github_pat_...)
const TOKEN_PREFIX_PATTERN =
  /(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}/gi;

// JSON formatted key-value pairs e.g. {"PASSWORD": "...", 'TOKEN': '...'} or {"password": 123}
const JSON_SENSITIVE_PATTERN = new RegExp(
  `(["'])(?:[A-Za-z0-9_]*${SENSITIVE_KEYWORD_FRAGMENT}[A-Za-z0-9_]*)\\1\\s*:\\s*(?:(["'])(?:\\\\.|(?!\\2)[^\\\\])*\\2|[^,\\s{}]+)`,
  "gi",
);

// Shell/env/config key-value pairs with double quotes, single quotes, or unquoted values
// e.g. PASSWORD="correct horse battery staple", API_KEY='...', SECRET=value
const KEY_VALUE_SENSITIVE_PATTERN = new RegExp(
  `\\b([A-Za-z0-9_]*${SENSITIVE_KEYWORD_FRAGMENT}[A-Za-z0-9_]*)\\s*[:=]\\s*(?:(["'])(?:\\\\.|(?!\\2)[^\\\\])*\\2|[^\\s,;"']+)`,
  "gi",
);

export function sanitizeEvidence(text: string, knownSecretValues: readonly string[] = []): string {
  if (typeof text !== "string") return "";
  let sanitized = text;

  // 1. Redact database URLs with embedded credentials
  sanitized = sanitized.replace(DATABASE_URL_PATTERN, "[REDACTED_DATABASE_URL]");

  // 2. Redact JSON-formatted sensitive key-value pairs
  sanitized = sanitized.replace(JSON_SENSITIVE_PATTERN, (_match, quote) => {
    return `${quote}[REDACTED_KEY]${quote}: "[REDACTED_CREDENTIAL]"`;
  });

  // 3. Redact multiline PEM private key blocks entirely
  sanitized = sanitized.replace(PEM_PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]");

  // 4. Redact shell/assignment-formatted sensitive key-value pairs (handling quoted values with spaces)
  // We use a replacer that checks if the value is already redacted
  sanitized = sanitized.replace(KEY_VALUE_SENSITIVE_PATTERN, (_match, key, quote, offset, fullStr) => {
    const remainder = fullStr.slice(offset + key.length);
    if (remainder.trimStart().startsWith("=[REDACTED_PRIVATE_KEY]")) {
      return `${key}=[REDACTED_PRIVATE_KEY]`;
    }
    return `${key}=[REDACTED_CREDENTIAL]`;
  });

  // 5. Redact raw token prefixes
  sanitized = sanitized.replace(TOKEN_PREFIX_PATTERN, "[REDACTED_TOKEN]");

  // 6. Redact any known secret values passed explicitly
  for (const secret of knownSecretValues) {
    if (typeof secret === "string" && secret.length >= 4) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED_CREDENTIAL]");
    }
  }

  return sanitized;
}

// Exhaustive set of all NodeJS.Signals from OS constants + standard portable extensions
const ALL_NODE_SIGNALS = new Set<string>([
  ...Object.keys(constants.signals ?? {}),
  // Portable/cross-platform signals guaranteed by NodeJS.Signals
  "SIGBREAK",
  "SIGLOST",
  "SIGINFO",
  "SIGUNUSED",
  "SIGSTKFLT",
]);

/**
 * Validates whether an object is a well-formed CommandExecutionResult.
 * Strictly verifies:
 * - exitCode: null or finite integer
 * - signal: null or valid NodeJS.Signals string
 * - stdout: string
 * - stderr: string
 * - durationMs: finite non-negative number
 * - timedOut: boolean
 */
export function isValidCommandExecutionResult(result: unknown): result is CommandExecutionResult {
  if (!result || typeof result !== "object") return false;
  const res = result as Record<string, unknown>;

  // Check required presence of all keys
  if (!("exitCode" in res) || !("signal" in res) || !("stdout" in res) || !("stderr" in res) || !("durationMs" in res) || !("timedOut" in res)) {
    return false;
  }

  const exitCode = res["exitCode"];
  const signal = res["signal"];
  const stdout = res["stdout"];
  const stderr = res["stderr"];
  const durationMs = res["durationMs"];
  const timedOut = res["timedOut"];

  // exitCode must be null or finite integer
  const exitCodeValid = exitCode === null || (typeof exitCode === "number" && Number.isInteger(exitCode));

  // signal must be null or valid signal string in ALL_NODE_SIGNALS
  const signalValid = signal === null || (typeof signal === "string" && ALL_NODE_SIGNALS.has(signal));

  // stdout and stderr must be strings
  const stdoutValid = typeof stdout === "string";
  const stderrValid = typeof stderr === "string";

  // durationMs must be finite non-negative number (reject NaN, Infinity, negative)
  const durationValid = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0;

  // timedOut must be boolean
  const timedOutValid = typeof timedOut === "boolean";

  return exitCodeValid && signalValid && stdoutValid && stderrValid && durationValid && timedOutValid;
}

/**
 * Robust command line tokenizer respecting single and double quotes.
 * Strict validation: rejects unclosed quotes or trailing backslash.
 */
export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escapeNext = false;
  let hasToken = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === undefined) continue;

    if (escapeNext) {
      current += char;
      hasToken = true;
      escapeNext = false;
      continue;
    }

    if (char === "\\") {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      hasToken = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      hasToken = true;
      continue;
    }

    if (/\s/.test(char) && !inDoubleQuote && !inSingleQuote) {
      if (hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }

    current += char;
    hasToken = true;
  }

  if (escapeNext) {
    throw createActionableError({
      code: "INVALID_INPUT",
      message: "Command line string ends with an unescaped trailing backslash",
      remediation: "Remove the trailing backslash or escape it properly (\\\\).",
      details: { commandLine: input },
    });
  }

  if (inDoubleQuote || inSingleQuote) {
    throw createActionableError({
      code: "INVALID_INPUT",
      message: `Command line string has an unclosed quote (${inDoubleQuote ? 'double quote "' : "single quote '"})`,
      remediation: "Ensure all opening quotes are paired with a matching closing quote.",
      details: { commandLine: input },
    });
  }

  if (hasToken) {
    tokens.push(current);
  }

  return tokens;
}

export function defaultCommandParser(check: DeclaredCheck): ParsedCheckCommand {
  if (!check || typeof check.description !== "string") {
    return {
      command: "",
      args: [],
      timeoutMs: 30_000,
    };
  }

  const parts = tokenizeCommandLine(check.description.trim());
  const command = parts[0] ?? "";
  const args = parts.slice(1);
  return {
    command,
    args,
    timeoutMs: 30_000,
  };
}

export class CompletionGate implements ICompletionGate {
  private readonly executor: ICommandExecutor;
  private readonly parser: CommandParser;

  constructor(
    executor: ICommandExecutor,
    parser: CommandParser = defaultCommandParser,
  ) {
    this.executor = executor;
    this.parser = parser;
  }

  async evaluate(input: GateEvaluationInput): Promise<GateEvaluationResult> {
    if (!input || typeof input !== "object") {
      throw createActionableError({
        code: "INVALID_INPUT",
        message: "Gate evaluation input must be an object",
        remediation: "Provide a valid GateEvaluationInput object.",
      });
    }

    if (!input.gateId || typeof input.gateId !== "string" || input.gateId.trim().length === 0) {
      throw createActionableError({
        code: "INVALID_INPUT",
        message: "Gate evaluation input missing or empty gateId",
        remediation: "Provide a valid non-empty gateId string in GateEvaluationInput.",
        details: { gateId: input.gateId },
      });
    }

    if (!Array.isArray(input.declaredChecks)) {
      throw createActionableError({
        code: "INVALID_INPUT",
        message: "Gate evaluation input missing declaredChecks array",
        remediation: "Provide an array of DeclaredCheck objects in GateEvaluationInput.",
      });
    }

    if (input.declaredChecks.length === 0) {
      throw createActionableError({
        code: "INVALID_INPUT",
        message: "Gate evaluation requires at least one declared verification check (declaredChecks must not be empty)",
        remediation: "Declare at least one verification check (unit test, linter, typecheck) before calling CompletionGate.",
        details: { gateId: input.gateId },
      });
    }

    const checkResults: GateCheckResult[] = [];
    let overallPassed = true;

    for (let i = 0; i < input.declaredChecks.length; i++) {
      const check = input.declaredChecks[i];

      if (
        !check ||
        typeof check !== "object" ||
        typeof check.id !== "string" ||
        check.id.trim().length === 0 ||
        typeof check.description !== "string"
      ) {
        const fallbackId = (check && typeof check === "object" && typeof check.id === "string" && check.id.trim().length > 0)
          ? check.id.trim()
          : `invalid_check_${i}`;

        checkResults.push({
          id: fallbackId,
          verdict: "FAIL",
          evidence: ["Check item is malformed: id must be non-empty string and description must be string"],
          message: `Declared check at index ${i} is malformed or has non-string id`,
        });
        overallPassed = false;
        continue;
      }

      const checkId = check.id.trim();
      const isRequired = check.required !== false; // Fail-closed

      let parsed: ParsedCheckCommand;
      try {
        parsed = this.parser(check);
      } catch (parserErr: unknown) {
        const errorMsg = parserErr instanceof Error ? parserErr.message : String(parserErr);
        checkResults.push({
          id: checkId,
          verdict: "FAIL",
          evidence: [sanitizeEvidence(`Parser error: ${errorMsg}`)],
          message: sanitizeEvidence(`Command parser rejected declared check '${checkId}': ${errorMsg}`),
        });
        if (isRequired) {
          overallPassed = false;
        }
        continue;
      }

      if (!parsed.command) {
        checkResults.push({
          id: checkId,
          verdict: "FAIL",
          evidence: ["Empty or unparseable check command"],
          message: `Declared check '${checkId}' has no executable command`,
        });
        if (isRequired) {
          overallPassed = false;
        }
        continue;
      }

      let rawExecResult: unknown;
      try {
        rawExecResult = await this.executor.execute({
          command: parsed.command,
          args: parsed.args,
          cwd: input.evidenceRoot,
          timeoutMs: parsed.timeoutMs,
        });
      } catch (execErr: unknown) {
        const errorMsg = execErr instanceof Error ? execErr.message : String(execErr);
        checkResults.push({
          id: checkId,
          verdict: "FAIL",
          evidence: [sanitizeEvidence(`Executor failure: ${errorMsg}`)],
          message: sanitizeEvidence(`Command executor threw an unexpected error: ${errorMsg}`),
        });
        if (isRequired) {
          overallPassed = false;
        }
        continue;
      }

      // Strict runtime validation of CommandExecutionResult
      if (!isValidCommandExecutionResult(rawExecResult)) {
        checkResults.push({
          id: checkId,
          verdict: "FAIL",
          evidence: ["Command executor returned a malformed CommandExecutionResult"],
          message: `Command executor output for check '${checkId}' violated the execution result contract`,
        });
        if (isRequired) {
          overallPassed = false;
        }
        continue;
      }

      const execResult: CommandExecutionResult = rawExecResult;
      const isPass = execResult.exitCode === 0 && !execResult.timedOut;
      const rawEvidence: string[] = [];

      if (execResult.stdout.trim()) {
        rawEvidence.push(`stdout: ${execResult.stdout.trim()}`);
      }
      if (execResult.stderr.trim()) {
        rawEvidence.push(`stderr: ${execResult.stderr.trim()}`);
      }
      if (execResult.timedOut) {
        rawEvidence.push(`Execution timed out after ${parsed.timeoutMs}ms`);
      }

      const sanitizedEvidence = (rawEvidence.length > 0 ? rawEvidence : [`exitCode: ${execResult.exitCode ?? "null"}`]).map(text => sanitizeEvidence(text));

      const checkVerdict = isPass ? "PASS" : "FAIL";
      if (!isPass && isRequired) {
        overallPassed = false;
      }

      checkResults.push({
        id: checkId,
        verdict: checkVerdict,
        evidence: sanitizedEvidence,
        message: isPass
          ? `Check '${checkId}' passed successfully.`
          : `Check '${checkId}' failed with exitCode ${execResult.exitCode ?? "null"}${
              execResult.timedOut ? " (timed out)" : ""
            }`,
      });
    }

    return {
      gateId: input.gateId,
      verdict: overallPassed ? "PASS" : "FAIL",
      evaluatedAt: new Date().toISOString(),
      checks: checkResults,
    };
  }
}
