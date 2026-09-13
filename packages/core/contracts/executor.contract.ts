export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface CommandExecutionResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface ICommandExecutor {
  execute(request: CommandRequest): Promise<CommandExecutionResult>;
}
