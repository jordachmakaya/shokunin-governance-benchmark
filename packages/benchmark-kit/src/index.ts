// Public contracts
export * from "../contracts/errors.contract.js";
export * from "../contracts/executor.contract.js";
export * from "../contracts/harbor.contract.js";
export * from "../contracts/trial.contract.js";
export * from "../contracts/ndjson.contract.js";
export * from "../contracts/runtime-protocol.contract.js";

// Public schemas
export * from "../schemas/trial.schema.js";
export * from "../schemas/harbor.schema.js";

// Errors and persistence utilities
export { ActionableBenchmarkError } from "./errors/actionable-error.js";
export { NDJsonStore, type NDJsonStoreOptions, repairPartialTail } from "./persistence/ndjson-store.js";
export { withFileLock } from "./persistence/file-lock.js";
export { SessionLedger } from "./persistence/session-ledger.js";
export * from "../schemas/ledger.schema.js";
export { parseHarborJobYaml } from "./adapters/yaml-parser.js";
export { computeTaskChecksum } from "./crypto/dirhash.js";
export {
  PINNED_HARBOR_VERSION,
  OFFICIAL_HARBOR_WHEEL_SHA256,
  OFFICIAL_HARBOR_WHEEL_FILE,
  type HarborDistributionAttestation,
  type HarborDistributionIdentity,
} from "./adapters/harbor-distribution-allowlist.js";
export { BRIDGE_ALLOWLIST, lookupBridgeVersion } from "./adapters/bridge-allowlist.js";
export { resolveEffectiveDigest } from "./adapters/docker-digest-resolver.js";
export { assertTrialUriExact } from "./adapters/trial-uri.js";
export {
  HarborBridgeSession,
  type HarborBridgeSessionOptions,
} from "./sessions/harbor-bridge-session.js";
export {
  HarborAdapter,
  evaluateSuccessCriterion,
  type HarborAdapterOptions,
  type PreflightOptions,
  type PreflightStatus,
} from "./adapters/harbor-adapter.js";
export { LocalProcessExecutor } from "./executors/process-executor.js";
export {
  executeVerticalSlice,
  assertNoSpecialFiles,
  makeReadOnlyRecursive,
  makeWritableRecursive,
  type VerticalSliceOptions,
  type VerticalSliceResult,
} from "./integration/vertical-slice.js";
