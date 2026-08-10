import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { sha256 } from "../../core/canonical-json.js";
import type { AdditionalAiSessionSummary, AdditionalAiSourceApi } from "./types.js";

const HISTORY_LIMIT_BYTES = 64 * 1024 * 1024;

export class AiderSourceApi implements AdditionalAiSourceApi {
  readonly provider = "AIDER" as const;
  readonly scopeIdentity: string;
  private readonly historyPath: string;

  constructor(options: { projectDirectory: string; historyFile: string }) {
    this.historyPath = resolve(options.historyFile);
    this.scopeIdentity = sha256(`aider:${resolve(options.projectDirectory)}:${this.historyPath}`);
  }

  async listSessions(options: { limit: number }) {
    if (options.limit < 1) return { items: [], coverage: "PARTIAL_LIMIT" as const };
    const info = await stat(this.historyPath);
    if (!info.isFile()) throw new Error("Aider chat history path is not a regular file");
    if (info.size > HISTORY_LIMIT_BYTES) throw new Error("Aider chat history exceeds the 64 MiB limit");
    const summary: AdditionalAiSessionSummary = {
      provider: this.provider, scopeIdentity: this.scopeIdentity,
      externalId: sha256(this.historyPath), createdAt: null,
      sourceUpdatedAt: info.mtime.toISOString(),
    };
    return { items: [summary], coverage: "COMPLETE_FOR_RETURNED_VIEW" as const };
  }

  async readSession(summary: AdditionalAiSessionSummary) {
    if (summary.provider !== this.provider || summary.scopeIdentity !== this.scopeIdentity) {
      throw new Error("Aider history summary is outside the configured scope");
    }
    const content = await readFile(this.historyPath, { encoding: "utf8" });
    if (Buffer.byteLength(content) > HISTORY_LIMIT_BYTES) throw new Error("Aider chat history exceeds the 64 MiB limit");
    const info = await stat(this.historyPath);
    const sourceUpdatedAt = info.mtime.toISOString();
    return {
      summary: { ...summary, sourceUpdatedAt },
      coverage: sourceUpdatedAt === summary.sourceUpdatedAt
        ? "UNKNOWN" as const
        : "PARTIAL_SOURCE_CHANGED" as const,
      messages: [],
      rawPayload: { schemaVersion: "axtory.aider.chat-history.v1", markdown: content },
      provenance: "DOCUMENTED_STORAGE" as const,
      dataClassification: "CONVERSATION_CONTENT" as const,
    };
  }
}
