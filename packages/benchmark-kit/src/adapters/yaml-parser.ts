import YAML from "yaml";
import { ActionableBenchmarkError } from "../errors/actionable-error.js";

/**
 * Standard, robust YAML parser for Harbor configuration manifests using pinned yaml@2.9.0.
 * Accurately parses nested mappings, inline comments, and preserves hashes inside quoted strings.
 */
export function parseHarborJobYaml(content: string): Record<string, unknown> {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ActionableBenchmarkError({
      code: "CONFIG_INVALID",
      message: "YAML content is empty or invalid.",
      remediation: "Provide a non-empty YAML configuration manifest.",
      retryable: false,
    });
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    throw new ActionableBenchmarkError({
      code: "CONFIG_INVALID",
      message: `Failed to parse YAML manifest: ${error instanceof Error ? error.message : String(error)}`,
      remediation: "Check the YAML syntax for formatting errors.",
      retryable: false,
      details: { parseError: String(error) },
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ActionableBenchmarkError({
      code: "CONFIG_INVALID",
      message: "Parsed YAML manifest must evaluate to a key-value object mapping.",
      remediation: "Ensure the top-level YAML element is an object dictionary.",
      retryable: false,
    });
  }

  return parsed as Record<string, unknown>;
}
