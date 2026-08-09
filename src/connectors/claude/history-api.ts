export interface ClaudeSessionInfo {
  sessionId: string;
  summary?: string;
  lastModified?: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  tag?: string;
  createdAt?: number;
  [key: string]: unknown;
}

export interface ClaudeSessionMessage {
  type: string;
  uuid?: string;
  session_id?: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  parent_agent_id?: string | null;
  [key: string]: unknown;
}

export interface ClaudeHistoryApi {
  listSessions(options?: {
    dir?: string;
    limit?: number;
    offset?: number;
    includeWorktrees?: boolean;
    includeProgrammatic?: boolean;
  }):
    Promise<ClaudeSessionInfo[]>;
  getSessionMessages(
    sessionId: string,
    options?: { dir?: string; limit?: number; offset?: number; includeSystemMessages?: boolean },
  ): Promise<ClaudeSessionMessage[]>;
  getSessionInfo?(
    sessionId: string,
    options?: { dir?: string },
  ): Promise<ClaudeSessionInfo | undefined>;
}

export type ModuleImporter = (specifier: string) => Promise<Record<string, unknown>>;

const dynamicImport: ModuleImporter = async (specifier) =>
  await import(specifier) as Record<string, unknown>;

export async function loadClaudeHistoryApi(
  importer: ModuleImporter = dynamicImport,
): Promise<ClaudeHistoryApi> {
  const packageName = "@anthropic-ai/claude-agent-sdk";
  let loaded: Record<string, unknown>;
  try {
    loaded = await importer(packageName);
  } catch (error) {
    throw new Error(
      "official Claude Agent SDK is not installed; install it separately without optional binaries",
      { cause: error },
    );
  }
  if (typeof loaded.listSessions !== "function" || typeof loaded.getSessionMessages !== "function" ||
      typeof loaded.getSessionInfo !== "function") {
    throw new Error("installed Claude Agent SDK does not expose the documented history read API");
  }
  return {
    listSessions: loaded.listSessions as ClaudeHistoryApi["listSessions"],
    getSessionMessages: loaded.getSessionMessages as ClaudeHistoryApi["getSessionMessages"],
    getSessionInfo: loaded.getSessionInfo as NonNullable<ClaudeHistoryApi["getSessionInfo"]>,
  };
}
