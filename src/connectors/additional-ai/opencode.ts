import { canonicalJson, sha256 } from "../../core/canonical-json.js";
import type { AdditionalAiCommandRunner } from "./command.js";
import { LocalAdditionalAiCommandRunner } from "./command.js";
import {
  externalIdentifier, isoTimestamp, object,
  type AdditionalAiMessage, type AdditionalAiSessionSummary, type AdditionalAiSourceApi,
} from "./types.js";

function role(value: unknown): AdditionalAiMessage["role"] {
  if (value === "user") return "USER";
  if (value === "assistant") return "ASSISTANT";
  if (value === "system") return "SYSTEM";
  if (value === "tool") return "TOOL";
  return "UNKNOWN";
}

export class OpenCodeSourceApi implements AdditionalAiSourceApi {
  readonly provider = "OPENCODE" as const;
  readonly scopeIdentity: string;
  private readonly runner: AdditionalAiCommandRunner;
  private readonly commandEnv = {
    NO_COLOR: "1", TERM: "dumb", OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_DISABLE_PRUNE: "true",
    OPENCODE_AUTO_SHARE: "false",
  } as const;

  constructor(private readonly options: {
    executablePath: string;
    projectDirectory: string;
    runner?: AdditionalAiCommandRunner;
  }) {
    this.scopeIdentity = sha256(`opencode:${options.projectDirectory}`);
    this.runner = options.runner ?? new LocalAdditionalAiCommandRunner();
  }

  async listSessions(options: { limit: number }) {
    const requested = Math.min(options.limit + 1, 10_001);
    const result = await this.runner.run(this.options.executablePath, [
      "--pure", "session", "list", "--format", "json", "--max-count", String(requested),
    ], { cwd: this.options.projectDirectory, timeoutMs: 20_000, env: this.commandEnv });
    if (result.exitCode !== 0) throw new Error("OpenCode session listing failed");
    let parsed: unknown;
    try {
      parsed = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    } catch (error) {
      throw new Error("OpenCode session list was not valid JSON", { cause: error });
    }
    if (!Array.isArray(parsed)) throw new Error("OpenCode session list must be an array");
    const values = parsed.map((value): AdditionalAiSessionSummary => {
      const item = object(value, "OpenCode session summary");
      return {
        provider: this.provider, scopeIdentity: this.scopeIdentity,
        externalId: externalIdentifier(item.id, "OpenCode session id"),
        createdAt: isoTimestamp(item.created), sourceUpdatedAt: isoTimestamp(item.updated),
      };
    });
    return {
      items: values.slice(0, options.limit),
      coverage: values.length > options.limit ? "PARTIAL_LIMIT" as const : "COMPLETE_FOR_RETURNED_VIEW" as const,
    };
  }

  async readSession(summary: AdditionalAiSessionSummary) {
    if (summary.provider !== this.provider || summary.scopeIdentity !== this.scopeIdentity) {
      throw new Error("OpenCode session summary is outside the configured scope");
    }
    const result = await this.runner.run(this.options.executablePath, ["--pure", "export", summary.externalId], {
      cwd: this.options.projectDirectory, timeoutMs: 30_000, maxBufferBytes: 64 * 1024 * 1024,
      env: this.commandEnv,
    });
    if (result.exitCode !== 0) throw new Error("OpenCode session export failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error("OpenCode session export was not valid JSON", { cause: error });
    }
    const root = object(parsed, "OpenCode session export");
    const info = object(root.info, "OpenCode session info");
    const exportedId = externalIdentifier(info.id, "OpenCode exported session id");
    if (exportedId !== summary.externalId) throw new Error("OpenCode export returned a different session");
    if (!Array.isArray(root.messages)) throw new Error("OpenCode session export messages must be an array");
    const messages = root.messages.map((value, index): AdditionalAiMessage => {
      const message = object(value, "OpenCode message");
      const messageInfo = object(message.info, "OpenCode message info");
      const parts = Array.isArray(message.parts) ? message.parts : [];
      const partTypes = parts.flatMap((partValue) => {
        const part = partValue && typeof partValue === "object" && !Array.isArray(partValue)
          ? partValue as Record<string, unknown>
          : {};
        return typeof part.type === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(part.type) ? [part.type] : [];
      });
      const time = messageInfo.time && typeof messageInfo.time === "object"
        ? object(messageInfo.time, "OpenCode message time")
        : {};
      return {
        externalId: typeof messageInfo.id === "string" ? messageInfo.id : `index-${index}`,
        role: role(messageInfo.role), occurredAt: isoTimestamp(time.created),
        contentIdentity: sha256(canonicalJson(parts)), partTypes,
      };
    });
    const exportedUpdatedAt = info.time && typeof info.time === "object"
      ? isoTimestamp(object(info.time, "OpenCode session time").updated)
      : null;
    return {
      summary: { ...summary, sourceUpdatedAt: exportedUpdatedAt ?? summary.sourceUpdatedAt },
      coverage: summary.sourceUpdatedAt && exportedUpdatedAt && summary.sourceUpdatedAt !== exportedUpdatedAt
        ? "PARTIAL_SOURCE_CHANGED" as const
        : "COMPLETE_FOR_RETURNED_VIEW" as const,
      messages, rawPayload: parsed,
      provenance: "OFFICIAL_API" as const, dataClassification: "CONVERSATION_CONTENT" as const,
    };
  }
}
