import { canonicalJson, sha256, stableId } from "../../core/canonical-json.js";
import type { NormalizedObservation } from "../../core/records.js";
import { isoFromEpoch, isoTimestamp } from "../../core/time.js";
import { namedBranch, namedWorkspace } from "../../core/workspace.js";
import type { ClaudeSessionInfo, ClaudeSessionMessage } from "./history-api.js";

export const CLAUDE_NORMALIZER_VERSION = "claude-official-history/3";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sourceTimestamp(item: ClaudeSessionMessage): string | null {
  return isoTimestamp(item.timestamp);
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return "UNKNOWN";
  if (/[\u0000-\u001F\u007F]/u.test(value)) return "UNKNOWN";
  return value;
}

function epochTimestamp(value: unknown): string | null {
  return isoFromEpoch(value, "MILLISECONDS");
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
      // The workspace a session ran in. Both values are path- and name-bearing, so only their
      // digests are kept: they group and filter sessions without revealing where work happened.
      ...(namedWorkspace(session.cwd)
        ? { workspaceIdentity: sha256(namedWorkspace(session.cwd)!) }
        : {}),
      ...(namedBranch(session.gitBranch)
        ? { branchIdentity: sha256(namedBranch(session.gitBranch)!) }
        : {}),
    },
  });
  messages.forEach((message, messageIndex) => {
    const occurredAt = sourceTimestamp(message);
    // Where the identity came from decides what may be concluded from two sessions sharing one.
    // A Vendor `uuid` is globally unique, so sharing it is evidence of a copy. The fallback hashes
    // the message index and content, so two sessions that merely opened with the same prompt would
    // share it. Recording the provenance keeps a fork analysis from reading the second as the first.
    const vendorUuid = message.uuid ?? null;
    const messageIdentity = sha256(vendorUuid ?? canonicalJson({ messageIndex, message: message.message }));
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
        sourceMessageIdentityFrom: vendorUuid === null ? "CONTENT_FALLBACK" : "VENDOR_UUID",
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
