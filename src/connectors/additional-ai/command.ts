import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AdditionalAiCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface AdditionalAiCommandRunner {
  run(command: string, args: readonly string[], options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBufferBytes?: number;
  }): Promise<AdditionalAiCommandResult>;
}

export class LocalAdditionalAiCommandRunner implements AdditionalAiCommandRunner {
  async run(command: string, args: readonly string[], options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBufferBytes?: number;
  }): Promise<AdditionalAiCommandResult> {
    try {
      const result = await execFileAsync(command, [...args], {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        timeout: options.timeoutMs,
        encoding: "utf8",
        maxBuffer: options.maxBufferBytes ?? 16 * 1024 * 1024,
        windowsHide: true,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const candidate = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean };
      if (candidate.killed) throw new Error("additional AI source command timed out");
      return {
        exitCode: typeof candidate.code === "number" ? candidate.code : 127,
        stdout: candidate.stdout ?? "",
        stderr: candidate.stderr ?? "",
      };
    }
  }
}
