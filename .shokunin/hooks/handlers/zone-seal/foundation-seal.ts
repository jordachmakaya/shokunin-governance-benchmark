import { resolve } from "node:path";
import { allow } from "../../lib/runtime.mjs";

const root = process.env.SHOKUNIN_BENCHMARK_ROOT;
if (!root) throw new Error("Missing hook runtime context.");

process.exitCode = 0;
await import(
  `${new URL(resolve(root, ".shokunin/scripts/gates/check-foundation.mjs"), "file:").href}?seal=${Date.now()}`
);
if (process.exitCode === 0) {
  allow("Foundation candidate checks pass; independent review is still required.");
}
