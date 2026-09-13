import { z } from "zod";

export const harborEnvironmentTypeSchema = z.enum([
  "docker",
  "daytona",
  "e2b",
  "modal",
  "runloop",
]).default("docker");

export const harborEnvironmentConfigSchema = z.object({
  type: harborEnvironmentTypeSchema.default("docker"),
  force_build: z.boolean().default(true),
  delete: z.boolean().default(true),
  kwargs: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export const harborOrchestratorTypeSchema = z.literal("local").default("local");

export const harborOrchestratorConfigSchema = z.object({
  type: harborOrchestratorTypeSchema.default("local"),
  n_concurrent_trials: z.number().int().positive().default(4),
  quiet: z.boolean().default(false),
  retry: z.record(z.string(), z.unknown()).optional().default({}),
  kwargs: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

export const harborJobTaskSchema = z.object({
  path: z.string().min(1),
  git_url: z.string().optional().nullable(),
  git_commit_id: z.string().optional().nullable(),
  overwrite: z.boolean().optional().default(false),
  download_dir: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
}).passthrough();

export const harborJobDatasetSchema = z
  .object({
    path: z.string().optional(),
    name: z.string().optional(),
    version: z.string().optional().default("head"),
    task_names: z.array(z.string()).optional().nullable(),
    exclude_task_names: z.array(z.string()).optional().nullable(),
    overwrite: z.boolean().optional().default(false),
    download_dir: z.string().optional().nullable(),
  })
  .passthrough()
  .refine(
    (d) => Boolean((d.path && d.path.trim().length > 0) || (d.name && d.name.trim().length > 0)),
    { message: "Dataset configuration must specify either non-empty 'path' or 'name'" },
  );

export const harborJobAgentSchema = z.object({
  name: z.string().min(1).default("oracle"),
  model_name: z.string().optional().nullable(),
  import_path: z.string().optional().nullable(),
  override_timeout_sec: z.number().finite().positive().optional().nullable(),
  kwargs: z.record(z.string(), z.unknown()).default({}),
}).passthrough();

const defaultEnvironmentConfig = {
  type: "docker" as const,
  force_build: true,
  delete: true,
  kwargs: {},
};

const defaultOrchestratorConfig = {
  type: "local" as const,
  n_concurrent_trials: 4,
  quiet: false,
  retry: {},
  kwargs: {},
};

export const harborJobConfigSchema = z
  .object({
    job_name: z.string().min(1).default("oracle-job"),
    jobs_dir: z.string().default("jobs"),
    n_attempts: z.number().int().positive().default(1),
    timeout_multiplier: z.number().finite().positive().default(1.0),
    orchestrator: harborOrchestratorConfigSchema.default(defaultOrchestratorConfig),
    environment: harborEnvironmentConfigSchema.default(defaultEnvironmentConfig),
    verifier: z.record(z.string(), z.unknown()).optional().default({}),
    metrics: z.array(z.record(z.string(), z.unknown())).optional().default([]),
    agents: z
      .array(harborJobAgentSchema)
      .min(1, "Job config must declare at least one agent"),
    tasks: z.array(harborJobTaskSchema).default([]),
    datasets: z.array(harborJobDatasetSchema).default([]),
  })
  .passthrough()
  .refine(
    (data) => data.tasks.length > 0 || data.datasets.length > 0,
    { message: "Either datasets or tasks must be provided." },
  );

export type HarborJobConfigData = z.infer<typeof harborJobConfigSchema>;

export const harborJobStatsSchema = z.object({
  n_trials: z.number().int().nonnegative().default(0),
  n_errors: z.number().int().nonnegative().default(0),
  evals: z.record(z.string(), z.unknown()).optional().default({}),
}).passthrough();

export const harborJobResultSchema = z.object({
  id: z.string().uuid("JobResult id must be a valid UUID"),
  started_at: z.iso.datetime({ local: true, message: "JobResult started_at must be an ISO datetime string" }),
  finished_at: z.iso.datetime({ local: true }).nullable().optional(),
  n_total_trials: z.number().int().nonnegative("n_total_trials must be a non-negative integer"),
  stats: harborJobStatsSchema,
}).passthrough();

export type HarborJobResultData = z.infer<typeof harborJobResultSchema>;

export const harborTimingInfoSchema = z.object({
  started_at: z.iso.datetime({ local: true }),
  finished_at: z.iso.datetime({ local: true }),
}).refine(
  (val) => new Date(val.started_at).getTime() <= new Date(val.finished_at).getTime(),
  { message: "finished_at must be greater than or equal to started_at" },
);

export const harborAgentResultSchema = z.object({
  n_input_tokens: z.number().int().nonnegative().nullable().optional(),
  n_cache_tokens: z.number().int().nonnegative().nullable().optional(),
  n_output_tokens: z.number().int().nonnegative().nullable().optional(),
  cost_usd: z.number().finite().nonnegative().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
}).passthrough();

export const harborExceptionInfoSchema = z.object({
  exception_type: z.string().min(1),
  exception_message: z.string().default(""),
  exception_traceback: z.string().optional().default(""),
  occurred_at: z.iso.datetime({ local: true }).optional(),
}).passthrough();

export const harborVerifierResultSchema = z.object({
  rewards: z
    .record(z.string().min(1), z.number().finite())
    .refine(
      (rewards) => Object.keys(rewards).length > 0,
      { message: "verifier_result.rewards must not be empty" },
    ),
}).nullable();

export const harborModelInfoSchema = z.object({
  name: z.string().min(1),
  provider: z.string().min(1),
}).passthrough();

export const harborAgentInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  model_info: harborModelInfoSchema.nullable().optional(),
}).passthrough();

export const harborTrialConfigSchema = z.object({
  task: harborJobTaskSchema,
  agent: harborJobAgentSchema,
  environment: harborEnvironmentConfigSchema.default(defaultEnvironmentConfig),
  verifier: z.record(z.string(), z.unknown()).optional().default({}),
}).passthrough();

export const harborLocalTaskIdSchema = z.object({
  path: z.string().min(1),
}).passthrough();

export const harborGitTaskIdSchema = z.object({
  path: z.string().min(1),
  git_url: z.string().min(1),
  git_commit_id: z.string().nullable().optional(),
}).passthrough();

export const harborTaskIdSchema = z.union([
  harborLocalTaskIdSchema,
  harborGitTaskIdSchema,
]);

export type HarborTaskIdData = z.infer<typeof harborTaskIdSchema>;

export const harborTrialResultSchema = z.object({
  id: z.string().uuid("TrialResult id must be a valid UUID"),
  task_name: z.string().min(1),
  trial_name: z.string().min(1),
  trial_uri: z.string().min(1),
  task_id: harborTaskIdSchema,
  task_checksum: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, "Task checksum must be a 64-character hexadecimal SHA-256 hash"),
  config: harborTrialConfigSchema,
  agent_info: harborAgentInfoSchema,
  verifier_result: harborVerifierResultSchema,
  exception_info: harborExceptionInfoSchema.nullable().optional(),
  started_at: z.iso.datetime({ local: true }).nullable().optional(),
  finished_at: z.iso.datetime({ local: true }).nullable().optional(),
  environment_setup: harborTimingInfoSchema.nullable().optional(),
  agent_setup: harborTimingInfoSchema.nullable().optional(),
  agent_execution: harborTimingInfoSchema.nullable().optional(),
  verifier: harborTimingInfoSchema.nullable().optional(),
  agent_result: harborAgentResultSchema.nullable().optional(),
}).passthrough();

export type HarborTrialResultData = z.infer<typeof harborTrialResultSchema>;
