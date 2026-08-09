import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

import {
  available,
  type CapabilityAssessment,
  type ExecutionEnvironment,
  type ExecutionEnvironmentType,
  type SourceProfile,
  unavailable,
} from "../../core/model.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], timeoutMs: number): Promise<CommandResult>;
}

export class LocalCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    try {
      const result = await execFileAsync(command, [...args], {
        timeout: timeoutMs,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const candidate = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      if (candidate.killed) {
        throw new Error(`command timed out after ${timeoutMs}ms`);
      }
      const exitCode = typeof candidate.code === "number" ? candidate.code : 127;
      return {
        exitCode,
        stdout: candidate.stdout ?? "",
        stderr: candidate.stderr ?? "",
      };
    }
  }
}

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  home?: string;
  runner?: CommandRunner;
  now?: () => Date;
}

export interface ClaudeDiscovery {
  environment: ExecutionEnvironment;
  sourceProfile: SourceProfile;
  capabilityAssessment: CapabilityAssessment;
  authMethod: string | null;
}

function environmentType(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ExecutionEnvironmentType {
  if (platform === "win32") return "WINDOWS";
  if (platform === "darwin") return "MACOS";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "WSL";
  if (platform === "linux") return "LINUX";
  return "UNKNOWN";
}

async function findOnPath(
  executable: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> {
  const pathValue = env.PATH;
  if (!pathValue) return null;
  const extensions = platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension.toLowerCase()}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return resolve(candidate);
      } catch {
        // Continue without treating an inaccessible PATH entry as a collection error.
      }
    }
  }
  return null;
}

function parseClaudeVersion(stdout: string): string | null {
  const match = stdout.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u);
  return match?.[1] ?? null;
}

export async function discoverClaude(options: DiscoveryOptions = {}): Promise<ClaudeDiscovery> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const home = options.home ?? homedir();
  const runner = options.runner ?? new LocalCommandRunner();
  const now = options.now ?? (() => new Date());
  const type = environmentType(platform, env);
  const environmentId = randomUUID();
  const sourceProfileId = randomUUID();
  const executable = await findOnPath("claude", env, platform);
  const configuredRoot = env.CLAUDE_CONFIG_DIR;
  const dataRoot = configuredRoot
    ? (isAbsolute(configuredRoot) ? configuredRoot : resolve(configuredRoot))
    : join(home, ".claude");

  let rootStatus: "AVAILABLE" | "SOURCE_UNAVAILABLE" | "PERMISSION_DENIED" = "AVAILABLE";
  let rootReason = "";
  try {
    const info = await stat(dataRoot);
    if (!info.isDirectory()) {
      rootStatus = "SOURCE_UNAVAILABLE";
      rootReason = "configured Claude data root is not a directory";
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    rootStatus = code === "EACCES" ? "PERMISSION_DENIED" : "SOURCE_UNAVAILABLE";
    rootReason = code === "EACCES"
      ? "Claude data root cannot be accessed"
      : "Claude data root does not exist";
  }

  let version = unavailable<string>("SOURCE_UNAVAILABLE", "Claude executable was not found on PATH");
  let versionReason = "Claude executable was not found on PATH";
  let installAvailability: "AVAILABLE" | "SOURCE_UNAVAILABLE" = "SOURCE_UNAVAILABLE";
  if (executable) {
    const result = await runner.run(executable, ["--version"], 5_000);
    const parsed = result.exitCode === 0 ? parseClaudeVersion(result.stdout) : null;
    if (parsed) {
      version = available(parsed);
      versionReason = "";
      installAvailability = "AVAILABLE";
    } else {
      version = unavailable("COLLECTION_ERROR", "Claude version output was unavailable or malformed");
      versionReason = "Claude version output was unavailable or malformed";
    }
  }

  let authAvailability: "AVAILABLE" | "COLLECTION_ERROR" | "SOURCE_UNAVAILABLE" =
    executable ? "COLLECTION_ERROR" : "SOURCE_UNAVAILABLE";
  let authReason = executable ? "Claude authentication status could not be read" : versionReason;
  let authMethod: string | null = null;
  if (executable) {
    const result = await runner.run(executable, ["auth", "status", "--json"], 10_000);
    try {
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      if (result.exitCode === 0 && payload.loggedIn === true) {
        authAvailability = "AVAILABLE";
        authReason = "";
        authMethod = typeof payload.authMethod === "string" ? payload.authMethod : null;
      } else {
        authAvailability = "SOURCE_UNAVAILABLE";
        authReason = "Claude reports that no active login is available";
      }
    } catch {
      authAvailability = "COLLECTION_ERROR";
      authReason = "Claude authentication output was not valid JSON";
    }
  }

  const environment: ExecutionEnvironment = {
    id: environmentId,
    type,
    os: platform,
    architecture,
    homeDirectory: available(home),
  };
  const sourceProfile: SourceProfile = {
    id: sourceProfileId,
    sourceType: "CLAUDE_CODE",
    environmentId,
    dataRoot: rootStatus === "AVAILABLE" ? available(dataRoot) : unavailable(rootStatus, rootReason),
    executablePath: executable
      ? available(executable)
      : unavailable("SOURCE_UNAVAILABLE", "Claude executable was not found on PATH"),
    activeVersion: version,
  };
  const capabilities = [
    {
      key: "claude.installation",
      availability: installAvailability,
      ...(versionReason ? { reason: versionReason } : {}),
      evidence: ["PATH lookup", "claude --version"],
    },
    {
      key: "claude.data_root",
      availability: rootStatus,
      ...(rootReason ? { reason: rootReason } : {}),
      evidence: [configuredRoot ? "CLAUDE_CONFIG_DIR" : "platform default", "filesystem stat"],
    },
    {
      key: "claude.auth",
      availability: authAvailability,
      ...(authReason ? { reason: authReason } : {}),
      evidence: ["claude auth status --json"],
    },
  ] as const;
  return {
    environment,
    sourceProfile,
    capabilityAssessment: {
      sourceProfileId,
      assessedAt: now().toISOString(),
      capabilities,
    },
    authMethod,
  };
}
