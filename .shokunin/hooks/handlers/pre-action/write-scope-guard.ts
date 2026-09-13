import {
  allow,
  assignmentFor,
  deny,
  inspectAction,
  normalizeRepositoryPath,
  pathIsAllowed,
  readJsonStdin,
} from "../../lib/runtime.mjs";

const root = process.env.SHOKUNIN_BENCHMARK_ROOT;
const actor = process.env.SHOKUNIN_ACTOR;
if (!root || !actor) throw new Error("Missing hook runtime context.");

const action = inspectAction(readJsonStdin());
if (!action.isWrite) {
  allow("Read-only action; write scope does not apply.", { tool: action.toolName });
} else {
  const assignment = assignmentFor(root, actor);
  if (assignment === null || assignment.status !== "ACTIVE") {
    deny(
      "OUT_OF_SCOPE",
      `${actor} is not assigned an active write zone.`,
      "Perform review-only work or request an assignment transfer in ACTIVE_ASSIGNMENTS.json.",
      { actor, status: assignment?.status ?? "UNASSIGNED" },
    );
  } else if (action.ambiguousShellWrite && action.paths.length === 0) {
    deny(
      "AMBIGUOUS_WRITE_TARGET",
      "A mutating shell command has no reliably identifiable target path.",
      "Use apply_patch or a write tool with an explicit repository-relative target.",
      { actor, tool: action.toolName },
    );
  } else if (action.paths.length === 0) {
    deny(
      "MISSING_WRITE_TARGET",
      "The write action does not declare a target path.",
      "Provide an explicit repository-relative target path.",
      { actor, tool: action.toolName },
    );
  } else {
    const normalized = action.paths.map((path) => ({
      supplied: path,
      normalized: normalizeRepositoryPath(root, path),
    }));
    const rejected = normalized.filter(
      ({ normalized: path }) => path === null || !pathIsAllowed(assignment, path),
    );
    if (rejected.length > 0) {
      deny(
        "OUT_OF_SCOPE",
        `Write target is outside ${actor}'s active zone ${assignment.zoneId}.`,
        "Write only to the exact files or roots declared for the active assignment.",
        { actor, rejected },
      );
    } else {
      allow("All declared write targets are within the active assignment.", {
        actor,
        paths: normalized.map(({ normalized: path }) => path),
      });
    }
  }
}
