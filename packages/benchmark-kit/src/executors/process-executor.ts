import {
  LocalCommandExecutor,
  type ICommandExecutor,
} from "@shokunin/core";
import type {
  ILocalProcessExecutor,
  LocalProcessRequest,
  LocalProcessResult,
} from "../../contracts/executor.contract.js";

/**
 * LocalProcessExecutor implements ILocalProcessExecutor by delegating to
 * the hardened LocalCommandExecutor from @shokunin/core.
 * This guarantees detached process-tree management, zero surviving child
 * descendants on timeout/kill, and safe bounded buffers.
 */
export class LocalProcessExecutor implements ILocalProcessExecutor {
  private readonly coreExecutor: ICommandExecutor;

  constructor(coreExecutor?: ICommandExecutor) {
    this.coreExecutor = coreExecutor ?? new LocalCommandExecutor();
  }

  async execute(request: LocalProcessRequest): Promise<LocalProcessResult> {
    const startedDate = new Date();
    const startedAt = startedDate.toISOString();

    const res = await this.coreExecutor.execute({
      command: request.executable,
      args: request.args,
      cwd: request.cwd,
      ...(request.env ? { env: request.env } : {}),
      timeoutMs: request.timeoutMs,
    });

    const finishedDate = new Date();
    return {
      exitCode: res.exitCode,
      signal: res.signal,
      stdout: res.stdout,
      stderr: res.stderr,
      startedAt,
      finishedAt: finishedDate.toISOString(),
      durationMs: res.durationMs,
      timedOut: res.timedOut,
    };
  }
}
