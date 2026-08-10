import { sha256 } from "../../core/canonical-json.js";
import type { AdditionalAiCommandRunner } from "./command.js";
import { LocalAdditionalAiCommandRunner } from "./command.js";
import type { AdditionalAiSessionSummary, AdditionalAiSourceApi } from "./types.js";

export class GeminiCliSourceApi implements AdditionalAiSourceApi {
  readonly provider = "GEMINI_CLI" as const;
  readonly scopeIdentity: string;
  private readonly runner: AdditionalAiCommandRunner;

  constructor(private readonly options: {
    executablePath: string;
    projectDirectory: string;
    runner?: AdditionalAiCommandRunner;
  }) {
    this.scopeIdentity = sha256(`gemini-cli:${options.projectDirectory}`);
    this.runner = options.runner ?? new LocalAdditionalAiCommandRunner();
  }

  async listSessions(options: { limit: number }) {
    const result = await this.runner.run(this.options.executablePath, ["--list-sessions"], {
      cwd: this.options.projectDirectory, timeoutMs: 20_000,
      env: { NO_COLOR: "1", TERM: "dumb" },
    });
    if (result.exitCode !== 0) throw new Error("Gemini CLI session listing failed");
    const declared = result.stdout.match(/Available sessions for this project \((\d+)\)/u);
    const declaredCount = declared ? Number(declared[1]) : null;
    const ids = [...result.stdout.matchAll(/\[([0-9a-fA-F-]{8,64})\]\s*$/gmu)].map((match) => match[1]!);
    if (declaredCount !== null && declaredCount > 0 && ids.length === 0) {
      throw new Error("Gemini CLI session list format is unsupported");
    }
    const unique = [...new Set(ids)];
    const items = unique.slice(0, options.limit).map((externalId): AdditionalAiSessionSummary => ({
      provider: this.provider, scopeIdentity: this.scopeIdentity, externalId,
      createdAt: null, sourceUpdatedAt: null,
    }));
    return {
      items,
      coverage: unique.length > options.limit ? "PARTIAL_LIMIT" as const : "METADATA_ONLY" as const,
    };
  }

  async readSession(summary: AdditionalAiSessionSummary) {
    if (summary.provider !== this.provider || summary.scopeIdentity !== this.scopeIdentity) {
      throw new Error("Gemini CLI session summary is outside the configured scope");
    }
    return {
      summary, coverage: "METADATA_ONLY" as const, messages: [],
      rawPayload: {
        schemaVersion: "axtory.gemini-cli.session-summary.v1",
        sessionIdentity: sha256(summary.externalId),
      },
      provenance: "OFFICIAL_API" as const, dataClassification: "LOCAL_METADATA" as const,
    };
  }
}
