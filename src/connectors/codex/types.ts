export const CODEX_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const;

export type CodexThreadSourceKind = (typeof CODEX_THREAD_SOURCE_KINDS)[number];

export interface CodexThreadItem {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  itemsView: "notLoaded" | "summary" | "full" | string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  [key: string]: unknown;
}

export interface CodexThread {
  id: string;
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: { type: string; [key: string]: unknown };
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: unknown;
  threadSource: unknown;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: unknown;
  name: string | null;
  turns: CodexTurn[];
  [key: string]: unknown;
}

export interface CodexThreadListParams {
  cursor?: string | null;
  limit?: number;
  sortKey?: "created_at" | "updated_at";
  sortDirection?: "asc" | "desc";
  sourceKinds?: readonly CodexThreadSourceKind[];
  archived?: boolean;
  useStateDbOnly: true;
}

export interface CodexThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor?: string | null;
}

export interface CodexThreadApi {
  listThreads(params: CodexThreadListParams): Promise<CodexThreadListResponse>;
  readThread(threadId: string): Promise<CodexThread>;
  close(): Promise<void>;
}
