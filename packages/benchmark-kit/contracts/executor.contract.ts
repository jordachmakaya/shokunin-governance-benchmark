export interface LocalProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly stdin?: string;
}

export interface LocalProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ILocalProcessExecutor {
  execute(request: LocalProcessRequest): Promise<LocalProcessResult>;
}
