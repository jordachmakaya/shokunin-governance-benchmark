import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";
import {
  OFFICIAL_HARBOR_WHEEL_SHA256,
} from "../adapters/harbor-distribution-allowlist.js";
import { BRIDGE_ALLOWLIST, lookupBridgeVersion } from "../adapters/bridge-allowlist.js";
import { resolveExecutableAbs } from "../adapters/docker-digest-resolver.js";
import type { HarborLaunchSpec } from "../../contracts/runtime-protocol.contract.js";

/**
 * @fileoverview Pure launch-authority resolution (ZB2.2-R8).
 *
 * R7 marked `wheel-verified` from the `kind` discriminant alone, so an
 * arbitrary `uvPath` plus arbitrary bridge bytes inherited full trust.
 * This module performs the checks as a pure function of verified inputs:
 * - the wheel bytes must equal the lab-owned official hash (else throw);
 * - the bridge bytes must equal a versioned lab-owned allowlist entry
 *   (else throw);
 * - for uv-wheel, caller-supplied launcher overrides are never evidence-grade;
 * - the system `uv` must resolve from the process environment to an existing
 *   file literally named `uv`/`uv.exe` (else cli-shape-only);
 * - plain launchers are always cli-shape-only.
 * `wheel-verified` therefore means: resolved uv binary + official wheel
 * bytes + allowlisted bridge bytes. Unit tests exercise this function
 * directly with real files; mocks can never produce wheel-verified.
 */

export interface LaunchAuthority {
  readonly command: string;
  readonly prefixArgs: readonly string[];
  readonly identity: "wheel-verified" | "cli-shape-only";
  readonly wheelSha256: string;
  readonly bridgeVersion: string | null;
  readonly bridgeSha256: string;
  /** Absolute resolved launcher path, or null when unresolvable. */
  readonly resolvedCommand: string | null;
}

const UV_BINARIES = new Set(["uv", "uv.exe"]);

export function resolveLaunchAuthority(args: {
  launch: HarborLaunchSpec;
  env?: Readonly<Record<string, string>> | undefined;
  wheelPath: string;
  bridgeScriptPath: string;
}): LaunchAuthority {
  const { launch, env, wheelPath, bridgeScriptPath } = args;
  if (!existsSync(wheelPath)) {
    throw new ActionableBenchmarkError({
      code: "HARNESS_UNAVAILABLE",
      message: `Harbor wheel not found: "${wheelPath}".`,
      remediation: "Provide the absolute path to the official Harbor distribution wheel.",
      retryable: false,
      details: { wheelPath },
    });
  }
  if (!existsSync(bridgeScriptPath)) {
    throw new ActionableBenchmarkError({
      code: "HARNESS_UNAVAILABLE",
      message: `Bridge script not found: "${bridgeScriptPath}".`,
      remediation: "Provide the absolute path to bridge/shokunin_intercept_agent.py.",
      retryable: false,
      details: { bridgeScriptPath },
    });
  }
  const wheelSha256 = createHash("sha256").update(readFileSync(wheelPath)).digest("hex");
  if (wheelSha256.toLowerCase() !== OFFICIAL_HARBOR_WHEEL_SHA256.toLowerCase()) {
    throw new ActionableBenchmarkError({
      code: "HARNESS_UNAVAILABLE",
      message: `Harbor wheel authentication failed: ${wheelPath} does not match the laboratory-pinned official wheel. Independent authority, not caller attestation.`,
      remediation: "Use the official Harbor 0.1.2 wheel vendored by the laboratory.",
      retryable: false,
      details: { wheelPath },
    });
  }
  const bridgeSha256 = createHash("sha256").update(readFileSync(bridgeScriptPath)).digest("hex");
  const bridgeVersion = lookupBridgeVersion(bridgeSha256);
  if (bridgeVersion === null) {
    throw new ActionableBenchmarkError({
      code: "HARNESS_UNAVAILABLE",
      message: `Bridge authentication failed: ${bridgeScriptPath} matches no versioned lab-owned allowlist entry (known: ${Object.keys(BRIDGE_ALLOWLIST).join(", ") || "none"}). Recording a hash is not authentication.`,
      remediation: "Use the laboratory bridge module at the allowlisted version, or register the new version explicitly.",
      retryable: false,
      details: { bridgeScriptPath },
    });
  }
  if (launch.kind === "uv-wheel") {
    // An explicit uvPath is caller-selected. Even when its basename is `uv`,
    // it may be an arbitrary executable and cannot establish publication
    // authority. Only the system launcher resolved from the reviewer process
    // environment can receive wheel-verified identity.
    if (launch.uvPath !== undefined) {
      const prefixArgs: string[] = [
        "run",
        "--python", launch.pythonVersion ?? "3.12",
        ...(launch.requirementsLockPath ? ["--with-requirements", launch.requirementsLockPath] : []),
        "--with", wheelPath,
        "python3", "-m", "harbor.cli.sb.main",
      ];
      return {
        command: launch.uvPath,
        prefixArgs,
        identity: "cli-shape-only",
        wheelSha256,
        bridgeVersion,
        bridgeSha256,
        resolvedCommand: resolveExecutableAbs(launch.uvPath, env),
      };
    }
    const uvAbs = resolveExecutableAbs("uv", process.env as Readonly<Record<string, string>>);
    const uvName = uvAbs !== null ? basename(uvAbs).toLowerCase() : null;
    if (uvAbs === null || !UV_BINARIES.has(uvName ?? "")) {
      // Arbitrary or unresolvable uv: unverified, never trusted (R8 item 3).
      return {
        command: "uv",
        prefixArgs: [],
        identity: "cli-shape-only",
        wheelSha256,
        bridgeVersion,
        bridgeSha256,
        resolvedCommand: null,
      };
    }
    const prefixArgs: string[] = [
      "run",
      "--python", launch.pythonVersion ?? "3.12",
      ...(launch.requirementsLockPath ? ["--with-requirements", launch.requirementsLockPath] : []),
      "--with", wheelPath,
      "python3", "-m", "harbor.cli.sb.main",
    ];
    return {
      command: uvAbs,
      prefixArgs,
      identity: "wheel-verified",
      wheelSha256,
      bridgeVersion,
      bridgeSha256,
      resolvedCommand: uvAbs,
    };
  }
  return {
    command: launch.executable,
    prefixArgs: [],
    identity: "cli-shape-only",
    wheelSha256,
    bridgeVersion,
    bridgeSha256,
    resolvedCommand: resolveExecutableAbs(launch.executable, env),
  };
}
