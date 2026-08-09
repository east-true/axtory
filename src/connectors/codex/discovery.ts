import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  available,
  type CapabilityAssessment,
  type ExecutionEnvironment,
  type ExecutionEnvironmentType,
  type SourceProfile,
  unavailable,
} from "../../core/model.js";
import { LocalCommandRunner, type CommandRunner } from "../claude/discovery.js";
import { findCodexStateDatabase } from "./snapshot.js";

export interface CodexDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  home?: string;
  runner?: CommandRunner;
  now?: () => Date;
}

export interface CodexDiscovery {
  environment: ExecutionEnvironment;
  sourceProfile: SourceProfile;
  capabilityAssessment: CapabilityAssessment;
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
  if (!env.PATH) return null;
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of env.PATH.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${executable}${extension.toLowerCase()}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return resolve(candidate);
      } catch {
        // An inaccessible PATH entry is not a collection failure.
      }
    }
  }
  return null;
}

function parseVersion(output: string): string | null {
  return output.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1] ?? null;
}

export async function discoverCodex(options: CodexDiscoveryOptions = {}): Promise<CodexDiscovery> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const runner = options.runner ?? new LocalCommandRunner();
  const now = options.now ?? (() => new Date());
  const executable = await findOnPath("codex", env, platform);
  const configuredHome = env.CODEX_HOME;
  const dataRoot = configuredHome
    ? (isAbsolute(configuredHome) ? configuredHome : resolve(configuredHome))
    : join(home, ".codex");

  let dataAvailability: "AVAILABLE" | "SOURCE_UNAVAILABLE" | "PERMISSION_DENIED" = "AVAILABLE";
  let dataReason = "";
  try {
    const metadata = await stat(dataRoot);
    if (!metadata.isDirectory()) {
      dataAvailability = "SOURCE_UNAVAILABLE";
      dataReason = "configured Codex data root is not a directory";
    } else {
      await findCodexStateDatabase(dataRoot);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    dataAvailability = code === "EACCES" ? "PERMISSION_DENIED" : "SOURCE_UNAVAILABLE";
    dataReason = code === "EACCES"
      ? "Codex data root cannot be read"
      : "Codex state database is unavailable";
  }

  let version = unavailable<string>("SOURCE_UNAVAILABLE", "Codex executable was not found on PATH");
  let installAvailability: "AVAILABLE" | "SOURCE_UNAVAILABLE" | "COLLECTION_ERROR" = "SOURCE_UNAVAILABLE";
  let installReason = "Codex executable was not found on PATH";
  if (executable) {
    const result = await runner.run(executable, ["--version"], 5_000);
    const parsed = result.exitCode === 0 ? parseVersion(result.stdout) : null;
    if (parsed) {
      version = available(parsed);
      installAvailability = "AVAILABLE";
      installReason = "";
    } else {
      version = unavailable("COLLECTION_ERROR", "Codex version output was unavailable or malformed");
      installAvailability = "COLLECTION_ERROR";
      installReason = "Codex version output was unavailable or malformed";
    }
  }

  let loginAvailability: "AVAILABLE" | "SOURCE_UNAVAILABLE" | "COLLECTION_ERROR" =
    executable ? "COLLECTION_ERROR" : "SOURCE_UNAVAILABLE";
  let loginReason = executable ? "Codex login status could not be read" : installReason;
  if (executable) {
    const result = await runner.run(executable, ["login", "status"], 10_000);
    if (result.exitCode === 0 && /logged in/u.test(result.stdout.toLowerCase())) {
      loginAvailability = "AVAILABLE";
      loginReason = "";
    } else if (result.exitCode === 0) {
      loginAvailability = "SOURCE_UNAVAILABLE";
      loginReason = "Codex reports no active login";
    }
  }

  const environmentId = randomUUID();
  const sourceProfileId = randomUUID();
  return {
    environment: {
      id: environmentId,
      type: environmentType(platform, env),
      os: platform,
      architecture: options.architecture ?? process.arch,
      homeDirectory: available(home),
    },
    sourceProfile: {
      id: sourceProfileId,
      sourceType: "CODEX",
      environmentId,
      dataRoot: dataAvailability === "AVAILABLE" ? available(dataRoot) : unavailable(dataAvailability, dataReason),
      executablePath: executable
        ? available(executable)
        : unavailable("SOURCE_UNAVAILABLE", "Codex executable was not found on PATH"),
      activeVersion: version,
    },
    capabilityAssessment: {
      sourceProfileId,
      assessedAt: now().toISOString(),
      capabilities: [
        { key: "codex.installation", availability: installAvailability,
          ...(installReason ? { reason: installReason } : {}), evidence: ["PATH lookup", "codex --version"] },
        { key: "codex.state", availability: dataAvailability,
          ...(dataReason ? { reason: dataReason } : {}), evidence: ["CODEX_HOME or platform default", "state DB probe"] },
        { key: "codex.login", availability: loginAvailability,
          ...(loginReason ? { reason: loginReason } : {}), evidence: ["codex login status"] },
      ],
    },
  };
}
