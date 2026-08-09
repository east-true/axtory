import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { delimiter, join, resolve } from "node:path";

import { available, type CapabilityAssessment, type ExecutionEnvironment, type SourceProfile, unavailable } from "../../core/model.js";
import type { AdditionalAiCommandRunner } from "./command.js";
import { LocalAdditionalAiCommandRunner } from "./command.js";
import type { AdditionalAiProvider } from "./types.js";

const EXECUTABLES: Readonly<Record<AdditionalAiProvider, string>> = {
  GEMINI_CLI: "gemini", OPENCODE: "opencode", CURSOR: "cursor-agent", AIDER: "aider",
};

export interface AdditionalAiDiscovery {
  provider: AdditionalAiProvider;
  environment: ExecutionEnvironment;
  sourceProfile: SourceProfile;
  capabilityAssessment: CapabilityAssessment;
}

async function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<string | null> {
  const pathValue = env.PATH;
  if (!pathValue) return null;
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      try {
        await access(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return resolve(candidate);
      } catch {
        // Continue across inaccessible PATH entries.
      }
    }
  }
  return null;
}

function environmentType(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ExecutionEnvironment["type"] {
  if (platform === "win32") return "WINDOWS";
  if (platform === "darwin") return "MACOS";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "WSL";
  if (platform === "linux") return "LINUX";
  return "UNKNOWN";
}

export async function discoverAdditionalAiSource(provider: AdditionalAiProvider, options: {
  projectDirectory: string;
  historyFile?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  architecture?: string;
  runner?: AdditionalAiCommandRunner;
  now?: () => Date;
}): Promise<AdditionalAiDiscovery> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const executable = await findExecutable(EXECUTABLES[provider], env, platform);
  const runner = options.runner ?? new LocalAdditionalAiCommandRunner();
  let version: string | null = null;
  if (executable) {
    const result = await runner.run(executable, ["--version"], {
      cwd: options.projectDirectory, timeoutMs: 5_000,
      env: { NO_COLOR: "1", TERM: "dumb" },
    });
    const match = result.exitCode === 0 ? result.stdout.match(/[0-9]{1,4}(?:\.[0-9A-Za-z-]+){1,4}/u) : null;
    version = match?.[0] ?? null;
  }
  let historyFileAvailable = false;
  if (provider === "AIDER" && options.historyFile) {
    try {
      historyFileAvailable = (await stat(options.historyFile)).isFile();
    } catch {
      historyFileAvailable = false;
    }
  }
  const sourceProfileId = randomUUID();
  const environmentId = randomUUID();
  const installed = executable !== null;
  const canEnumerate = provider === "AIDER" ? historyFileAvailable : installed;
  const installationReason = installed
    ? undefined
    : `${EXECUTABLES[provider]} executable was not found on PATH.`;
  const enumerationReason = canEnumerate
    ? undefined
    : provider === "AIDER"
      ? "The configured Aider chat history file is unavailable."
      : `${EXECUTABLES[provider]} executable is required to enumerate sessions.`;
  const contentAvailability = provider === "OPENCODE" && installed
    ? "AVAILABLE"
    : provider === "AIDER" && historyFileAvailable
      ? "PARTIAL"
      : "NOT_SUPPORTED";
  return {
    provider,
    environment: {
      id: environmentId, type: environmentType(platform, env), os: platform,
      architecture: options.architecture ?? process.arch,
      homeDirectory: unavailable("REDACTED", "home directory is not retained for additional AI discovery"),
    },
    sourceProfile: {
      id: sourceProfileId, sourceType: "ADDITIONAL_AI", environmentId,
      dataRoot: unavailable("REDACTED", "provider data root is not exported"),
      executablePath: executable
        ? available(executable)
        : unavailable("SOURCE_UNAVAILABLE", `${EXECUTABLES[provider]} executable was not found on PATH`),
      activeVersion: version
        ? available(version)
        : unavailable(installed ? "COLLECTION_ERROR" : "SOURCE_UNAVAILABLE", "version is unavailable"),
    },
    capabilityAssessment: {
      sourceProfileId, assessedAt: (options.now ?? (() => new Date()))().toISOString(),
      capabilities: [
        { key: "additional_ai.installation", availability: installed ? "AVAILABLE" : "SOURCE_UNAVAILABLE",
          ...(installationReason ? { reason: installationReason } : {}), evidence: ["PATH lookup", "--version"] },
        { key: "additional_ai.session_enumeration", availability: canEnumerate ? "AVAILABLE" : "SOURCE_UNAVAILABLE",
          ...(enumerationReason ? { reason: enumerationReason } : {}),
          evidence: [provider === "AIDER" ? "documented history file" : "official CLI list command"] },
        { key: "additional_ai.session_content", availability: contentAvailability,
          ...(contentAvailability === "NOT_SUPPORTED"
            ? { reason: "Provider exposes no non-mutating structured history read contract." }
            : contentAvailability === "PARTIAL"
              ? { reason: "Aider exposes a documented Markdown log but no stable message schema." }
              : {}),
          evidence: [provider === "OPENCODE" ? "opencode export JSON" : provider === "AIDER" ? "chat-history-file" : "official documentation"] },
      ],
    },
  };
}
