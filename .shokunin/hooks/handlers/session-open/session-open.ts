import { resolve } from "node:path";
import {
  allow,
  assignmentFor,
  readJson,
} from "../../lib/runtime.mjs";

const root = process.env.SHOKUNIN_BENCHMARK_ROOT;
const actor = process.env.SHOKUNIN_ACTOR;
if (!root || !actor) throw new Error("Missing hook runtime context.");

const repository = readJson(resolve(root, ".shokunin/BENCHMARK_REPO.json"));
const assignment = assignmentFor(root, actor);
if (!repository.autonomous || assignment === null) {
  throw new Error(`No autonomous repository assignment exists for ${actor}.`);
}

allow("Autonomous benchmark repository session verified.", {
  actor,
  phase: repository.phase,
  assignmentStatus: assignment.status,
});
