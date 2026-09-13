import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const MARKER = "SHOKUNIN_BENCHMARK_MANAGED_HOOK=1";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rootFromModule() {
  return resolve(new URL("../../../", import.meta.url).pathname);
}

function guardedCommand(event, actor) {
  const script =
    'cursor="$PWD"; while [ "$cursor" != "/" ]; do if [ -f "$cursor/.shokunin/BENCHMARK_REPO.json" ]; then exec node "$cursor/.shokunin/hooks/runners/run-event.mjs" --event "$1" --actor "$2"; fi; cursor="${cursor%/*}"; [ -n "$cursor" ] || cursor="/"; done; exit 0';
  return `${MARKER} sh -c '${script}' sh '${event}' '${actor}'`;
}

function stripManagedHooks(config) {
  const next = structuredClone(config);
  if (!next.hooks || typeof next.hooks !== "object") next.hooks = {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    next.hooks[event] = groups
      .map((group) => {
        if (!group || !Array.isArray(group.hooks)) return group;
        return {
          ...group,
          hooks: group.hooks.filter(
            (hook) =>
              typeof hook?.command !== "string" || !hook.command.includes(MARKER),
          ),
        };
      })
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
  }
  return next;
}

export function reconcileConfig(config, client, adapter) {
  const next = stripManagedHooks(config);
  const routes = adapter.clients[client];
  if (!Array.isArray(routes)) throw new Error(`Unknown hook client: ${client}`);
  for (const route of routes) {
    if (!Array.isArray(next.hooks[route.nativeEvent])) {
      next.hooks[route.nativeEvent] = [];
    }
    next.hooks[route.nativeEvent].push({
      matcher: route.matcher,
      hooks: [
        {
          type: "command",
          command: guardedCommand(route.canonicalEvent, client),
          timeout: 10,
        },
      ],
    });
  }
  return next;
}

export function defaultTarget(client, root = rootFromModule()) {
  if (client === "claude-code") return resolve(root, ".claude/settings.json");
  if (client === "gemini") return resolve(root, ".gemini/settings.json");
  if (client === "codex") return resolve(homedir(), ".codex/hooks.json");
  throw new Error(`Unknown hook client: ${client}`);
}

export function materializeClient({ client, target, dryRun = false }) {
  const root = rootFromModule();
  const adapter = readJson(resolve(root, ".shokunin/hooks/harness-adapter.json"));
  const output = target ?? defaultTarget(client, root);
  const existing = existsSync(output) ? readJson(output) : {};
  const once = reconcileConfig(existing, client, adapter);
  const twice = reconcileConfig(once, client, adapter);
  if (JSON.stringify(once) !== JSON.stringify(twice)) {
    throw new Error(`${client} hook materialization is not idempotent.`);
  }
  if (!dryRun) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(once, null, 2)}\n`, "utf8");
  }
  return { client, target: output, config: once };
}

export function managedMarker() {
  return MARKER;
}
