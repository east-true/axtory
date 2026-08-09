import { canonicalJson, sha256, stableId } from "../../core/canonical-json.js";
import type { NormalizedObservation } from "../../core/records.js";
import type { ClaudeSessionInfo, ClaudeSessionMessage } from "./history-api.js";

export const CLAUDE_NORMALIZER_VERSION = "claude-official-history/1";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceTimestamp(item: ClaudeSessionMessage): string | null {
  const timestamp = item.timestamp;
  if (typeof timestamp !== "string") return null;
  const milliseconds = Date.parse(timestamp);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return "UNKNOWN";
  if (/[\u0000-\u001F\u007F]/u.test(value)) return "UNKNOWN";
  return value;
}

function epochTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeClaudeSession(
  session: ClaudeSessionInfo,
  messages: readonly ClaudeSessionMessage[],
  revisionId: string,
  messageCoverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION" | "PARTIAL_SOURCE_CHANGED",
): NormalizedObservation[] {
  const observations: NormalizedObservation[] = [];
  const add = (input: Omit<NormalizedObservation, "id" | "sourceRevisionId" | "derivation" | "provenance">) => {
    observations.push({
      ...input,
      id: stableId("obs", { revisionId, stableKey: input.stableKey }),
      sourceRevisionId: revisionId,
      derivation: "OBSERVED",
      provenance: "OFFICIAL_API",
    });
  };
  add({
    stableKey: "session",
    kind: "SNAPSHOT",
    dataClassification: "LOCAL_METADATA",
    occurredAt: epochTimestamp(session.createdAt),
    timeQuality: epochTimestamp(session.createdAt) ? "SOURCE_REPORTED" : "UNKNOWN",
    payload: {
      sourceConversationIdentity: sha256(session.sessionId),
      messageCountInReturnedView: messages.length,
      messageCoverage,
      sourceModifiedAt: epochTimestamp(session.lastModified),
    },
  });
  messages.forEach((message, messageIndex) => {
    const occurredAt = sourceTimestamp(message);
    const messageIdentity = sha256(message.uuid ?? canonicalJson({ messageIndex, message: message.message }));
    add({
      stableKey: `message:${messageIndex}:${messageIdentity}`,
      kind: "CONTENT",
      dataClassification: "CONVERSATION_CONTENT",
      occurredAt,
      timeQuality: occurredAt ? "SOURCE_REPORTED" : "ORDER_ONLY",
      payload: {
        role: message.type,
        contentIdentity: sha256(canonicalJson(message.message ?? null)),
        sourceMessageIdentity: messageIdentity,
        ...(message.parent_tool_use_id
          ? { parentToolUseIdentity: sha256(message.parent_tool_use_id) }
          : {}),
        ...(message.parent_agent_id
          ? { parentAgentIdentity: sha256(message.parent_agent_id) }
          : {}),
      },
    });
    const envelope = record(message.message);
    const blocks = Array.isArray(envelope?.content) ? envelope.content : [];
    blocks.forEach((block, blockIndex) => {
      const value = record(block);
      if (value?.type !== "tool_use") return;
      add({
        stableKey: `tool-occurrence:${messageIndex}:${blockIndex}:${messageIdentity}`,
        kind: "EVENT",
        dataClassification: "TOOL_CONTENT",
        occurredAt,
        timeQuality: occurredAt ? "SOURCE_REPORTED" : "ORDER_ONLY",
        payload: {
          toolName: safeToolName(value.name),
          usageOccurrenceId: stableId("usage", { revisionId, messageIdentity, blockIndex }),
          contentIdentity: sha256(canonicalJson(value.input ?? null)),
        },
      });
    });
  });
  return observations;
}
