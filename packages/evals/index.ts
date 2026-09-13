/**
 * ZB3 — Public surface of the evals package.
 */

// Contracts (frozen public API)
export type {
  IEvalsEngine,
  EvalReport,
  ArmSuccessMetrics,
  AttritionRecord,
  AttritionReason,
  BcaBootstrapConfig,
  PairedComparisonResult,
  PairingKey,
  IntentionToTreatResult,
  SensitivityAnalysisResult,
} from "./contracts/evals.contract.js";
export { ActionableEvalsError } from "./contracts/errors.contract.js";
export type { EvalsErrorCode } from "./contracts/errors.contract.js";

// Schemas
export {
  bcaBootstrapConfigSchema,
  attritionRecordSchema,
  armSuccessMetricsSchema,
  pairedComparisonResultSchema,
  evalReportMetadataSchema,
  evalReportSchema,
} from "./schemas/evals-report.schema.js";

// Engine
export { EvalsEngine } from "./src/engine.js";
