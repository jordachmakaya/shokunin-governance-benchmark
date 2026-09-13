export interface HarborJobRequestBase {
  readonly jobConfigPath: string;
  readonly jobsRoot: string;
  readonly expectedJobName: string;
  readonly timeoutMs: number;
  readonly successCriterion: string;
}

export type HarborJobRequestWithExpectedChecksum = HarborJobRequestBase & {
  readonly expectedTaskChecksum: string;
  readonly taskDirectory?: undefined;
};

export type HarborJobRequestWithTaskDirectory = HarborJobRequestBase & {
  readonly taskDirectory: string;
  readonly expectedTaskChecksum?: undefined;
};

export type HarborJobRequest =
  | HarborJobRequestWithExpectedChecksum
  | HarborJobRequestWithTaskDirectory;

export interface HarborTrialReference {
  readonly jobName: string;
  readonly trialName: string;
  readonly resultPath: string;
}

export interface HarborJobResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly jobDirectory: string;
  readonly trials: readonly HarborTrialReference[];
}

export interface IHarborRunner {
  run(request: HarborJobRequest): Promise<HarborJobResult>;
}
