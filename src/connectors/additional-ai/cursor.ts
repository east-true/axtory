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

  /**
   * Cursor Agent exposes no non-mutating session listing.
   *
   * `cursor-agent ls` reads as a listing command but the shipped CLI documents it as "Resume a chat
   * session" and implements it as an interactive picker: it takes no options, renders a TUI, and
   * blocks on stdin until the caller's timeout fires. `--print` and `--output-format json` apply
   * only to running a prompt, which would start an agent rather than observe one.
   *
   * Spawning it anyway would burn the timeout on every collection and report "command timed out",
   * blaming a slow command for a capability the Vendor does not offer. Verified against
   * cursor-agent 2026.08.04-aaa8809.
   */
  async listSessions(_options: { limit: number }): Promise<never> {
    throw new Error(
      "Cursor Agent exposes no non-interactive session listing; `cursor-agent ls` is an interactive resume picker",
    );
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
