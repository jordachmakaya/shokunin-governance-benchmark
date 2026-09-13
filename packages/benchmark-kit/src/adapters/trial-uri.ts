import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";

/**
 * @fileoverview Canonical trial-URI binding (ZB2.2-R6).
 *
 * R5 accepted any confined path ending with the trial directory name, so
 * `/expected-job/foreign/trial-1` passed for `/expected-job/trial-1`
 * (NESTED_SAME_SUFFIX). R6 imposes EXACT equality between the realpath of
 * the URI and the realpath of the discovered trial directory. Only canonical
 * `file://` URIs are admitted; every other scheme (including `custom://`),
 * unparseable URIs and dangling targets are rejected fail-closed.
 */
export function assertTrialUriExact(trialUri: string, expectedTrialDirAbs: string): void {
  const fail = (message: string): never => {
    throw new ActionableBenchmarkError({
      code: "RESULT_INVALID",
      message,
      remediation: "Ensure Harbor trial_uri is a canonical file:// URI exactly equal to its discovered trial directory.",
      retryable: false,
      details: { trialUri, expectedTrialDirAbs },
    });
  };

  if (/^(?:https?|ftp|sftp):\/\//i.test(trialUri)) {
    fail(`External trial_uri "${trialUri}" rejected. Only canonical file:// URIs are allowed.`);
  }
  if (!trialUri.startsWith("file://")) {
    fail(`Unsupported trial_uri scheme in "${trialUri}". Only file:// URIs are allowed (custom schemes rejected).`);
  }
  let uriPath: string;
  try {
    uriPath = decodeURIComponent(new URL(trialUri).pathname);
  } catch {
    fail(`Unparseable file trial_uri "${trialUri}".`);
  }
  const resolvedUri = realpathOrFail(uriPath!, `Trial URI target does not resolve on disk: "${trialUri}".`, trialUri, expectedTrialDirAbs);
  const resolvedExpected = realpathOrFail(
    resolve(expectedTrialDirAbs),
    `Expected trial directory does not resolve on disk: "${expectedTrialDirAbs}".`,
    trialUri,
    expectedTrialDirAbs,
  );
  if (resolvedUri !== resolvedExpected) {
    fail(
      `Trial URI "${trialUri}" resolves to "${resolvedUri}" instead of the discovered trial directory "${resolvedExpected}". Suffix confinement is insufficient: exact realpath equality is required.`,
    );
  }
}

function realpathOrFail(candidate: string, message: string, trialUri: string, expectedTrialDirAbs: string): string {
  try {
    return realpathSync(resolve(candidate));
  } catch {
    throw new ActionableBenchmarkError({
      code: "RESULT_INVALID",
      message,
      remediation: "Ensure Harbor trial_uri is a canonical file:// URI exactly equal to its discovered trial directory.",
      retryable: false,
      details: { trialUri, expectedTrialDirAbs },
    });
  }
}
