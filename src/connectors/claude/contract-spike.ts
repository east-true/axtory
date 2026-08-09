import type {
  ClaudeHistoryApi,
  ClaudeSessionInfo,
  ClaudeSessionMessage,
} from "./history-api.js";

export interface StructuralSessionReport {
  metadataFields: readonly string[];
  unknownMetadataFieldCount: number;
  messageCount: number;
  roles: Readonly<Record<string, number>>;
  messageEnvelopeFields: readonly string[];
  unknownMessageEnvelopeFieldCount: number;
  contentBlockTypes: Readonly<Record<string, number>>;
  parentLinkCount: number;
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_LIMIT" | "UNKNOWN";
}

export interface ClaudeContractReport {
  schemaVersion: "axtory.claude-contract-spike.v1";
  generatedAt: string;
  sessionCount: number;
  sessionCoverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_LIMIT" | "UNKNOWN";
  sessions: readonly StructuralSessionReport[];
  limitations: readonly string[];
}

const SAFE_METADATA_FIELDS = new Set(["createdAt", "fileSize", "lastModified"]);
const OMITTED_METADATA_FIELDS = new Set([
  "sessionId", "summary", "customTitle", "firstPrompt", "cwd", "gitBranch", "tag",
]);
const SAFE_MESSAGE_ENVELOPE_FIELDS = new Set(["parent_agent_id", "timestamp", "type"]);
const OMITTED_MESSAGE_ENVELOPE_FIELDS = new Set([
  "uuid", "session_id", "message", "parent_tool_use_id",
]);
const SAFE_MESSAGE_TYPES = new Set(["assistant", "result", "system", "user"]);
const SAFE_BLOCK_TYPES = new Set(["text", "thinking", "tool_use", "tool_result"]);

function fieldFingerprint(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  omitted: ReadonlySet<string>,
): { fields: string[]; unknownCount: number } {
  const keys = Object.keys(value);
  return {
    fields: keys.filter((key) => allowed.has(key)).sort(),
    unknownCount: keys.filter((key) => !allowed.has(key) && !omitted.has(key)).length,
  };
}

function inspectBlockTypes(message: unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!message || typeof message !== "object") return counts;
  const content = (message as Record<string, unknown>).content;
  const blocks = Array.isArray(content) ? content : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      counts.UNKNOWN = (counts.UNKNOWN ?? 0) + 1;
      continue;
    }
    const type = (block as Record<string, unknown>).type;
    const label = typeof type === "string" && SAFE_BLOCK_TYPES.has(type) ? type : "UNKNOWN";
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

function mergeCounts(target: Record<string, number>, source: Readonly<Record<string, number>>): void {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + count;
  }
}

function inspectMessages(messages: readonly ClaudeSessionMessage[], limit: number): StructuralSessionReport {
  const roles: Record<string, number> = {};
  const blockTypes: Record<string, number> = {};
  const envelopeFields = new Set<string>();
  let unknownMessageEnvelopeFieldCount = 0;
  let parentLinkCount = 0;
  for (const item of messages) {
    const role = typeof item.type === "string" && SAFE_MESSAGE_TYPES.has(item.type) ? item.type : "UNKNOWN";
    roles[role] = (roles[role] ?? 0) + 1;
    const fingerprint = fieldFingerprint(
      item,
      SAFE_MESSAGE_ENVELOPE_FIELDS,
      OMITTED_MESSAGE_ENVELOPE_FIELDS,
    );
    unknownMessageEnvelopeFieldCount += fingerprint.unknownCount;
    for (const field of fingerprint.fields) {
      envelopeFields.add(field);
    }
    mergeCounts(blockTypes, inspectBlockTypes(item.message));
    if (typeof item.parent_tool_use_id === "string" && item.parent_tool_use_id.length > 0) {
      parentLinkCount += 1;
    }
  }
  return {
    metadataFields: [],
    unknownMetadataFieldCount: 0,
    messageCount: messages.length,
    roles,
    messageEnvelopeFields: [...envelopeFields].sort(),
    unknownMessageEnvelopeFieldCount,
    contentBlockTypes: blockTypes,
    parentLinkCount,
    coverage: messages.length === limit ? "PARTIAL_LIMIT" : "COMPLETE_FOR_RETURNED_VIEW",
  };
}

export async function runClaudeContractSpike(
  api: ClaudeHistoryApi,
  options: { sessionLimit?: number; messageLimit?: number; now?: () => Date } = {},
): Promise<ClaudeContractReport> {
  const sessionLimit = options.sessionLimit ?? 25;
  const messageLimit = options.messageLimit ?? 200;
  const now = options.now ?? (() => new Date());
  const sessions = await api.listSessions({ limit: sessionLimit, includeWorktrees: true });
  const reports: StructuralSessionReport[] = [];
  for (const session of sessions) {
    const messages = await api.getSessionMessages(session.sessionId, { limit: messageLimit, offset: 0 });
    const report = inspectMessages(messages, messageLimit);
    const metadata = fieldFingerprint(session, SAFE_METADATA_FIELDS, OMITTED_METADATA_FIELDS);
    reports.push({
      ...report,
      metadataFields: metadata.fields,
      unknownMetadataFieldCount: metadata.unknownCount,
    });
  }
  return {
    schemaVersion: "axtory.claude-contract-spike.v1",
    generatedAt: now().toISOString(),
    sessionCount: sessions.length,
    sessionCoverage: sessions.length === sessionLimit ? "PARTIAL_LIMIT" : "COMPLETE_FOR_RETURNED_VIEW",
    sessions: reports,
    limitations: [
      "Report contains only returned-view structure; it does not claim source completeness.",
      "Prompt, response, tool payload, path, account, session, and message identifiers are excluded.",
      "Resume boundaries are not reconstructed from a session transcript.",
      "Active-session snapshot consistency and compaction behavior require controlled follow-up spikes.",
    ],
  };
}

export function assertSanitizedReport(report: ClaudeContractReport): void {
  const encoded = JSON.stringify(report);
  const forbiddenKeys = ["sessionId", "firstPrompt", "customTitle", "cwd", "gitBranch", "uuid"];
  for (const key of forbiddenKeys) {
    if (encoded.includes(`\"${key}\"`)) {
      throw new Error(`sanitized report contains forbidden field: ${key}`);
    }
  }
}
