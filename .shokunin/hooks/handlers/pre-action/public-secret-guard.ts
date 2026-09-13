import {
  allow,
  containsPublicSecretRisk,
  deny,
  inspectAction,
  normalizeRepositoryPath,
  readJson,
  readJsonStdin,
} from "../../lib/runtime.mjs";
import { resolve } from "node:path";

const root = process.env.SHOKUNIN_BENCHMARK_ROOT;
if (!root) throw new Error("Missing hook runtime context.");

const action = inspectAction(readJsonStdin());
const systems = readJson(resolve(root, ".shokunin/systems/SYSTEM_REGISTRY.json"));
const publicRoots = systems.systems.flatMap((system) => system.publicRoots);
const publicTargets = action.paths
  .map((path) => normalizeRepositoryPath(root, path))
  .filter((path) =>
    publicRoots.some(
      (publicRoot) => path === publicRoot || path?.startsWith(`${publicRoot}/`),
    ),
  );
if (
  action.isWrite &&
  publicTargets.length > 0 &&
  containsPublicSecretRisk(action.searchableText)
) {
  deny(
    "PUBLIC_SECRET_RISK",
    "The public write contains a credential-like value or a private/raw evidence reference.",
    "Remove secrets and publish only sanitized aggregate artifacts.",
    { publicTargets },
  );
} else {
  allow("No public secret exposure detected.", { publicTargets });
}
