import assert from "node:assert/strict";
import test from "node:test";
import {
  CompletionGate,
  defaultCommandParser,
  isValidCommandExecutionResult,
  sanitizeEvidence,
  tokenizeCommandLine,
} from "../src/completion-gate.js";
import { LocalCommandExecutor, filterSafeEnvironment } from "../src/local-command-executor.js";
import { ActionableError, createActionableError } from "../src/errors.js";
import type {
  CommandExecutionResult,
  CommandRequest,
  ICommandExecutor,
} from "../contracts/executor.contract.js";
import type {
  DeclaredCheck,
  GateEvaluationInput,
} from "../contracts/gate.contract.js";
import { gateEvaluationResultSchema } from "../schemas/gate-result.schema.js";

class FakeCommandExecutor implements ICommandExecutor {
  public executedRequests: CommandRequest[] = [];
  public resultsToReturn: Map<string, unknown> = new Map();
  public shouldExplodeWith?: Error;
  public defaultResult: CommandExecutionResult = {
    exitCode: 0,
    signal: null,
    stdout: "success",
    stderr: "",
    durationMs: 10,
    timedOut: false,
  };

  async execute(request: CommandRequest): Promise<CommandExecutionResult> {
    if (this.shouldExplodeWith) {
      throw this.shouldExplodeWith;
    }
    this.executedRequests.push(request);
    const key = `${request.command} ${request.args.join(" ")}`;
    return (
      (this.resultsToReturn.get(key) as CommandExecutionResult) ??
      (this.resultsToReturn.get(request.command) as CommandExecutionResult) ??
      this.defaultResult
    );
  }
}

test("CompletionGate evaluates all checks passing and conforms to schema", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  const gate = new CompletionGate(fakeExecutor);

  const checks: DeclaredCheck[] = [
    { id: "lint", description: "npm run lint", required: true },
    { id: "test", description: "npm test", required: true },
  ];

  const input: GateEvaluationInput = {
    gateId: "GATE_Z5_TEST",
    declaredChecks: checks,
    evidenceRoot: "/tmp/fake-workspace",
  };

  const result = await gate.evaluate(input);

  assert.equal(result.verdict, "PASS");
  assert.equal(result.checks.length, 2);
  assert.equal(result.checks[0]?.verdict, "PASS");
  assert.equal(result.checks[1]?.verdict, "PASS");

  // Validate output against Zod schema
  const parseResult = gateEvaluationResultSchema.safeParse(result);
  assert.equal(parseResult.success, true);
});

test("CompletionGate returns FAIL if any required check fails", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  fakeExecutor.resultsToReturn.set("npm test", {
    exitCode: 1,
    signal: null,
    stdout: "2 tests failed",
    stderr: "AssertionError: expected true",
    durationMs: 15,
    timedOut: false,
  });

  const gate = new CompletionGate(fakeExecutor);

  const checks: DeclaredCheck[] = [
    { id: "lint", description: "npm run lint", required: true },
    { id: "test", description: "npm test", required: true },
  ];

  const input: GateEvaluationInput = {
    gateId: "GATE_Z5_TEST",
    declaredChecks: checks,
    evidenceRoot: "/tmp/fake-workspace",
  };

  const result = await gate.evaluate(input);

  assert.equal(result.verdict, "FAIL");
  assert.equal(result.checks[0]?.verdict, "PASS");
  assert.equal(result.checks[1]?.verdict, "FAIL");
  assert.match(result.checks[1]?.evidence[0] ?? "", /2 tests failed/);

  // Schema validation holds even on failure
  const parseResult = gateEvaluationResultSchema.safeParse(result);
  assert.equal(parseResult.success, true);
});

test("CompletionGate respects non-required checks (does not fail gate)", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  fakeExecutor.resultsToReturn.set("npm run optional-audit", {
    exitCode: 1,
    signal: null,
    stdout: "advisories found",
    stderr: "",
    durationMs: 15,
    timedOut: false,
  });

  const gate = new CompletionGate(fakeExecutor);

  const checks: DeclaredCheck[] = [
    { id: "lint", description: "npm run lint", required: true },
    { id: "audit", description: "npm run optional-audit", required: false },
  ];

  const input: GateEvaluationInput = {
    gateId: "GATE_Z5_TEST",
    declaredChecks: checks,
    evidenceRoot: "/tmp/fake-workspace",
  };

  const result = await gate.evaluate(input);

  assert.equal(result.verdict, "PASS");
  assert.equal(result.checks[0]?.verdict, "PASS");
  assert.equal(result.checks[1]?.verdict, "FAIL");

  const parseResult = gateEvaluationResultSchema.safeParse(result);
  assert.equal(parseResult.success, true);
});

test("CompletionGate handles command timeout gracefully with FAIL verdict", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  fakeExecutor.resultsToReturn.set("npm test", {
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "Killed",
    durationMs: 30000,
    timedOut: true,
  });

  const gate = new CompletionGate(fakeExecutor);

  const checks: DeclaredCheck[] = [
    { id: "test", description: "npm test", required: true },
  ];

  const input: GateEvaluationInput = {
    gateId: "GATE_Z5_TIMEOUT",
    declaredChecks: checks,
    evidenceRoot: "/tmp/fake-workspace",
  };

  const result = await gate.evaluate(input);

  assert.equal(result.verdict, "FAIL");
  assert.equal(result.checks[0]?.verdict, "FAIL");
  assert.match(result.checks[0]?.evidence.join(" ") ?? "", /timed out/);
});

test("CompletionGate throws ActionableError on invalid input (empty checks or missing gateId)", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  const gate = new CompletionGate(fakeExecutor);

  // Missing gateId
  await assert.rejects(
    async () => {
      await gate.evaluate({
        gateId: "",
        declaredChecks: [{ id: "lint", description: "npm test", required: true }],
        evidenceRoot: "/tmp",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ActionableError);
      assert.equal(err.code, "INVALID_INPUT");
      return true;
    },
  );

  // VULN-01 test: Empty declaredChecks must be rejected
  await assert.rejects(
    async () => {
      await gate.evaluate({
        gateId: "GATE_EMPTY",
        declaredChecks: [],
        evidenceRoot: "/tmp",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof ActionableError);
      assert.equal(err.code, "INVALID_INPUT");
      assert.match(err.message, /requires at least one declared verification check/);
      return true;
    },
  );
});

test("tokenizeCommandLine correctly preserves quoted arguments and empty strings (VULN-04 fix)", () => {
  const cmd = 'sh -c "exit 0" --message \'hello world\' ""';
  const tokens = tokenizeCommandLine(cmd);
  assert.deepEqual(tokens, ["sh", "-c", "exit 0", "--message", "hello world", ""]);
});

test("tokenizeCommandLine rejects unclosed quotes and trailing backslash with ActionableError (Point 6)", () => {
  assert.throws(
    () => tokenizeCommandLine('sh -c "unclosed quote'),
    (err: unknown) => err instanceof ActionableError && err.code === "INVALID_INPUT",
  );
  assert.throws(
    () => tokenizeCommandLine("echo test\\"),
    (err: unknown) => err instanceof ActionableError && err.code === "INVALID_INPUT",
  );
});

test("ActionableError serialization is idempotent without prefix accumulation (VULN-05 fix)", () => {
  const err1 = new ActionableError({
    code: "INVALID_INPUT",
    message: "Missing parameter",
    remediation: "Provide parameter",
  });
  const json1 = err1.toJSON();
  assert.equal(json1.message, "Missing parameter");

  const err2 = new ActionableError(json1);
  const json2 = err2.toJSON();
  assert.equal(json2.message, "Missing parameter");
  assert.equal(err2.message, "[INVALID_INPUT] Missing parameter");
});

test("CompletionGate catches executor explosion fail-closed and scrubs secrets (Bloquant 2 fix)", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  fakeExecutor.shouldExplodeWith = new Error("executor exploded unexpectedly with NPM_TOKEN=npm_example_token_123456");

  const gate = new CompletionGate(fakeExecutor);
  const result = await gate.evaluate({
    gateId: "GATE_EXPLOSION",
    declaredChecks: [{ id: "test", description: "npm test", required: true }],
    evidenceRoot: "/tmp",
  });

  assert.equal(result.verdict, "FAIL");
  assert.equal(result.checks[0]?.verdict, "FAIL");
  assert.match(result.checks[0]?.message ?? "", /executor threw an unexpected error/);
  assert.ok(!result.checks[0]?.message.includes("npm_example_token_123456"));
  assert.match(result.checks[0]?.message ?? "", /NPM_TOKEN=\[REDACTED_CREDENTIAL\]/);
  const parseResult = gateEvaluationResultSchema.safeParse(result);
  assert.equal(parseResult.success, true);
});

test("isValidCommandExecutionResult strictly validates all result fields including SIGBREAK and SIGINFO (P2 fix)", () => {
  // Missing signal
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
    false,
  );

  // Invalid signal
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: 0,
      signal: "NOT_A_REAL_SIGNAL",
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
    false,
  );

  // SIGBREAK, SIGLOST, SIGINFO should be valid
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: null,
      signal: "SIGBREAK",
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
    true,
  );
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: null,
      signal: "SIGINFO",
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
    true,
  );
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: null,
      signal: "SIGLOST",
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
    true,
  );

  // exitCode NaN or non-integer
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: Number.NaN,
      signal: null,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
    false,
  );
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: 1.5,
      signal: null,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
    }),
    false,
  );

  // durationMs Infinity or negative
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      durationMs: Number.POSITIVE_INFINITY,
      timedOut: false,
    }),
    false,
  );
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      durationMs: -5,
      timedOut: false,
    }),
    false,
  );

  // Valid standard result
  assert.equal(
    isValidCommandExecutionResult({
      exitCode: 0,
      signal: null,
      stdout: "ok",
      stderr: "",
      durationMs: 10,
      timedOut: false,
    }),
    true,
  );
});

test("CompletionGate handles malformed CommandExecutionResult fail-closed (P1 #1 fix)", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  // Return malformed result missing signal
  fakeExecutor.resultsToReturn.set("npm test", {
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    durationMs: 1,
    timedOut: false,
  });

  const gate = new CompletionGate(fakeExecutor);
  const result = await gate.evaluate({
    gateId: "GATE_MALFORMED_RES",
    declaredChecks: [{ id: "test", description: "npm test", required: true }],
    evidenceRoot: "/tmp",
  });

  assert.equal(result.verdict, "FAIL");
  assert.equal(result.checks[0]?.verdict, "FAIL");
  assert.match(result.checks[0]?.evidence[0] ?? "", /malformed CommandExecutionResult/);
  const parseResult = gateEvaluationResultSchema.safeParse(result);
  assert.equal(parseResult.success, true);
});

test("CompletionGate enforces valid string id and schema validation even with non-string id (Bloquant 3 fix)", async () => {
  const fakeExecutor = new FakeCommandExecutor();
  const gate = new CompletionGate(fakeExecutor);

  const result = await gate.evaluate({
    gateId: "GATE_NON_STRING_ID",
    // @ts-expect-error Testing runtime boundary with invalid non-string id
    declaredChecks: [{ id: 123, description: "npm test", required: true }],
    evidenceRoot: "/tmp",
  });

  assert.equal(result.verdict, "FAIL");
  assert.equal(typeof result.checks[0]?.id, "string");
  const parseResult = gateEvaluationResultSchema.safeParse(result);
  assert.equal(parseResult.success, true);
});

test("sanitizeEvidence scrubs generic secrets, quoted strings, JSON payloads, and all PEM private key variants (RSA, EC, OPENSSH)", () => {
  const raw = [
    'PASSWORD="correct horse battery staple"',
    '{"NPM_TOKEN":"npm_example_token_123456"}',
    "APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
    "GENERIC_ABCDEF0123456789",
    "-----END PRIVATE KEY-----",
    "RSA_KEY=-----BEGIN RSA PRIVATE KEY-----",
    "RSA_PRIVATE_BODY_123456789",
    "-----END RSA PRIVATE KEY-----",
    "EC_KEY=-----BEGIN EC PRIVATE KEY-----",
    "EC_PRIVATE_BODY_123456789",
    "-----END EC PRIVATE KEY-----",
    "OPENSSH_KEY=-----BEGIN OPENSSH PRIVATE KEY-----",
    "OPENSSH_PRIVATE_BODY_123456789",
    "-----END OPENSSH PRIVATE KEY-----",
    "STRIPE_API_KEY=stripe_example_123456",
    "CUSTOM_TOKEN='custom_example_with spaces inside'",
    "DATABASE_URL=postgres://user:super_secret_pw@db.internal:5432/production",
    "SECRET_KEY=secret_example_123456",
  ].join("\n");

  const sanitized = sanitizeEvidence(raw);

  // 1. Quoted passwords with spaces
  assert.ok(!sanitized.includes("correct horse battery staple"));
  assert.match(sanitized, /PASSWORD=\[REDACTED_CREDENTIAL\]/);

  // 2. JSON formatted secrets
  assert.ok(!sanitized.includes("npm_example_token_123456"));
  assert.match(sanitized, /\[REDACTED_CREDENTIAL\]/);

  // 3. Multiline PEM blocks entirely redacted across all standard variants
  // Generic PKCS#8
  assert.ok(!sanitized.includes("-----BEGIN PRIVATE KEY-----"));
  assert.ok(!sanitized.includes("GENERIC_ABCDEF0123456789"));
  assert.ok(!sanitized.includes("-----END PRIVATE KEY-----"));

  // RSA (PKCS#1)
  assert.ok(!sanitized.includes("-----BEGIN RSA PRIVATE KEY-----"));
  assert.ok(!sanitized.includes("RSA_PRIVATE_BODY_123456789"));
  assert.ok(!sanitized.includes("-----END RSA PRIVATE KEY-----"));

  // EC (SEC1)
  assert.ok(!sanitized.includes("-----BEGIN EC PRIVATE KEY-----"));
  assert.ok(!sanitized.includes("EC_PRIVATE_BODY_123456789"));
  assert.ok(!sanitized.includes("-----END EC PRIVATE KEY-----"));

  // OPENSSH
  assert.ok(!sanitized.includes("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.ok(!sanitized.includes("OPENSSH_PRIVATE_BODY_123456789"));
  assert.ok(!sanitized.includes("-----END OPENSSH PRIVATE KEY-----"));

  // All 4 PEM keys replaced cleanly with [REDACTED_PRIVATE_KEY]
  assert.match(sanitized, /APP_PRIVATE_KEY=\[REDACTED_PRIVATE_KEY\]/);
  assert.match(sanitized, /RSA_KEY=\[REDACTED_PRIVATE_KEY\]/);
  assert.match(sanitized, /EC_KEY=\[REDACTED_PRIVATE_KEY\]/);
  assert.match(sanitized, /OPENSSH_KEY=\[REDACTED_PRIVATE_KEY\]/);

  // 4. Other generic secrets & URLs
  assert.ok(!sanitized.includes("stripe_example_123456"));
  assert.ok(!sanitized.includes("custom_example_with spaces inside"));
  assert.ok(!sanitized.includes("super_secret_pw"));
  assert.ok(!sanitized.includes("secret_example_123456"));
  assert.match(sanitized, /\[REDACTED_DATABASE_URL\]/);
});

test("filterSafeEnvironment passes only allowlisted environment variables (P1 #2 fix)", () => {
  const originalEnv = process.env;
  try {
    process.env = {
      PATH: "/usr/bin:/bin",
      HOME: "/home/user",
      DATABASE_URL: "postgres://user:pw@host/db",
      SECRET_KEY: "super_secret",
    };

    const filtered = filterSafeEnvironment({ CUSTOM_TEST: "123" });
    assert.equal(filtered["PATH"], "/usr/bin:/bin");
    assert.equal(filtered["HOME"], "/home/user");
    assert.equal(filtered["CUSTOM_TEST"], "123");
    assert.equal(filtered["DATABASE_URL"], undefined);
    assert.equal(filtered["SECRET_KEY"], undefined);
  } finally {
    process.env = originalEnv;
  }
});

test("LocalCommandExecutor executes real echo command successfully", async () => {
  const executor = new LocalCommandExecutor();
  const result = await executor.execute({
    command: "echo",
    args: ["shokunin"],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.trim(), "shokunin");
});

test("LocalCommandExecutor terminates background child processes on drain timeout (Bloquant 1 fix)", async () => {
  const executor = new LocalCommandExecutor();
  const start = Date.now();
  const result = await executor.execute({
    command: "sh",
    args: ["-c", "(sleep 5 &) ; echo parent_done"],
    cwd: process.cwd(),
    timeoutMs: 4000,
  });

  const duration = Date.now() - start;
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /parent_done/);
  assert.ok(duration < 2500, `Expected duration < 2500ms, got ${duration}ms`);
});

test("LocalCommandExecutor caps buffer to prevent memory exhaustion (VULN-03 fix)", async () => {
  const executor = new LocalCommandExecutor({ maxBufferBytes: 1024 }); // 1KB limit
  const result = await executor.execute({
    command: "sh",
    args: ["-c", "head -c 5000 /dev/zero | tr '\\0' 'A'"],
    cwd: process.cwd(),
    timeoutMs: 5000,
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.length <= 1500); // capped + warning message
  assert.match(result.stdout, /WARN: stdout truncated/);
});
