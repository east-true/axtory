import { sha256 } from "../../core/canonical-json.js";
import type { AdditionalAiCommandRunner } from "./command.js";
import { LocalAdditionalAiCommandRunner } from "./command.js";
import type { AdditionalAiSessionSummary, AdditionalAiSourceApi } from "./types.js";

export class CursorSourceApi implements AdditionalAiSourceApi {
  readonly provider = "CURSOR" as const;
  readonly scopeIdentity: string;
  private readonly runner: AdditionalAiCommandRunner;

  constructor(private readonly options: {
    executablePath: string;
    projectDirectory: string;
    runner?: AdditionalAiCommandRunner;
  }) {
    this.scopeIdentity = sha256(`cursor:${options.projectDirectory}`);
    this.runner = options.runner ?? new LocalAdditionalAiCommandRunner();
  }

  async listSessions(options: { limit: number }) {
    const result = await this.runner.run(this.options.executablePath, ["ls"], {
      cwd: this.options.projectDirectory, timeoutMs: 20_000,
      env: { NO_COLOR: "1", TERM: "dumb" },
    });
    if (result.exitCode !== 0) throw new Error("Cursor session listing failed");
    const ids = [...new Set([...result.stdout.matchAll(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/gu,
    )].map((match) => match[0]))];
    if (result.stdout.trim() && ids.length === 0 && !/no (?:sessions|chats)/iu.test(result.stdout)) {
      throw new Error("Cursor session list format is unsupported");
    }
    const items = ids.slice(0, options.limit).map((externalId): AdditionalAiSessionSummary => ({
      provider: this.provider, scopeIdentity: this.scopeIdentity, externalId,
      createdAt: null, sourceUpdatedAt: null,
    }));
    return {
      items,
      coverage: ids.length > options.limit ? "PARTIAL_LIMIT" as const : "METADATA_ONLY" as const,
    };
  }

  async readSession(summary: AdditionalAiSessionSummary) {
    if (summary.provider !== this.provider || summary.scopeIdentity !== this.scopeIdentity) {
      throw new Error("Cursor session summary is outside the configured scope");
    }
    return {
      summary, coverage: "METADATA_ONLY" as const, messages: [],
      rawPayload: {
        schemaVersion: "axtory.cursor.session-summary.v1",
        sessionIdentity: sha256(summary.externalId),
      },
      provenance: "OFFICIAL_API" as const, dataClassification: "LOCAL_METADATA" as const,
    };
  }
}
