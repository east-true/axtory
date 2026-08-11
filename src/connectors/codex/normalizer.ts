import { canonicalJson, sha256, stableId } from "../../core/canonical-json.js";
import type { NormalizedObservation } from "../../core/records.js";
import { isoFromEpoch } from "../../core/time.js";
import type { CodexThread, CodexThreadItem, CodexTurn } from "./types.js";

export const CODEX_NORMALIZER_VERSION = "codex-app-server/1";

export type CodexMessageCoverage =
  | "COMPLETE_FOR_RETURNED_VIEW"
  | "PARTIAL_PAGINATION"
  | "PARTIAL_COMPACTION"
  | "PARTIAL_SOURCE_CHANGED"
  | "PARTIAL_UNSETTLED_TURN";

function epochSeconds(value: unknown): string | null {
  return isoFromEpoch(value, "SECONDS");
}

function sourceKind(value: unknown): string {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("subAgent" in value) return "subAgent";
    if ("custom" in value) return "custom";
  }
  return "unknown";
}

/**
 * Read the parent a spawned subagent thread declares.
 *
 * The top-level `parentThreadId` is null on every observed subagent thread. App Server 0.147.0
 * instead carries the link inside the source variant, as
 * `source.subAgent.thread_spawn.parent_thread_id`; a bounded read of 126 real subagent threads had
 * it populated on all of them and the top-level field populated on none. Only the id is read and it
 * is hashed by the caller: the same object also carries an agent path and nickname, which stay out
 * of canonical observations.
 */
function spawnedParentThreadId(source: unknown): string | null {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return null;
  const subAgent = (source as Record<string, unknown>).subAgent;
  if (subAgent === null || typeof subAgent !== "object" || Array.isArray(subAgent)) return null;
  const spawn = (subAgent as Record<string, unknown>).thread_spawn;
  if (spawn === null || typeof spawn !== "object" || Array.isArray(spawn)) return null;
  const parent = (spawn as Record<string, unknown>).parent_thread_id;
  return typeof parent === "string" && parent.length > 0 ? parent : null;
}

function toolName(item: CodexThreadItem): string | null {
  switch (item.type) {
    case "commandExecution": return "commandExecution";
    case "fileChange": return "fileChange";
    case "mcpToolCall": return typeof item.tool === "string" ? `mcp:${item.tool.slice(0, 128)}` : "mcpToolCall";
    case "dynamicToolCall": return typeof item.tool === "string" ? `dynamic:${item.tool.slice(0, 128)}` : "dynamicToolCall";
    case "collabAgentToolCall": return "collabAgentToolCall";
    case "subAgentActivity": return "subAgentActivity";
    case "webSearch": return "webSearch";
    case "imageView": return "imageView";
    case "sleep": return "sleep";
    case "imageGeneration": return "imageGeneration";
    default: return null;
  }
}

function messageRole(item: CodexThreadItem): "user" | "assistant" | null {
  if (item.type === "userMessage") return "user";
  if (item.type === "agentMessage") return "assistant";
  return null;
}

function itemTimestamp(turn: CodexTurn): string | null {
  return epochSeconds(turn.startedAt);
}

export function normalizeCodexThread(
  thread: CodexThread,
  revisionId: string,
  messageCoverage: CodexMessageCoverage,
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
  const createdAt = epochSeconds(thread.createdAt);
  add({
    stableKey: "session",
    kind: "SNAPSHOT",
    dataClassification: "LOCAL_METADATA",
    occurredAt: createdAt,
    timeQuality: createdAt ? "SOURCE_REPORTED" : "UNKNOWN",
    payload: {
      sourceConversationIdentity: sha256(thread.id),
      sourceSessionIdentity: sha256(thread.sessionId),
      messageCountInReturnedView: thread.turns.reduce(
        (count, turn) => count + turn.items.filter((item) => messageRole(item) !== null).length,
        0,
      ),
      turnCountInReturnedView: thread.turns.length,
      messageCoverage,
      sourceModifiedAt: epochSeconds(thread.updatedAt),
      sourceKind: sourceKind(thread.source),
      status: typeof thread.status?.type === "string" ? thread.status.type : "unknown",
      ephemeral: thread.ephemeral === true,
    },
  });
  const parentThreadId = thread.parentThreadId ?? spawnedParentThreadId(thread.source);
  // App Server spawns a subagent by forking, so a spawned thread reports the same id in both
  // `forkedFromId` and its spawn parent. Emitting FORKED_FROM as well would label one link as two
  // different lineage kinds and present an agent spawn as a user fork. A fork that points somewhere
  // other than the spawn parent is a real fork and is still recorded.
  if (thread.forkedFromId && thread.forkedFromId !== parentThreadId) {
    add({
      stableKey: "relation:forked-from",
      kind: "RELATION",
      dataClassification: "LOCAL_METADATA",
      occurredAt: createdAt,
      timeQuality: createdAt ? "SOURCE_REPORTED" : "UNKNOWN",
      payload: {
        relationType: "FORKED_FROM",
        sourceThreadIdentity: sha256(thread.id),
        targetThreadIdentity: sha256(thread.forkedFromId),
      },
    });
  }
  if (parentThreadId) {
    add({
      stableKey: "relation:subagent-of",
      kind: "RELATION",
      dataClassification: "LOCAL_METADATA",
      occurredAt: createdAt,
      timeQuality: createdAt ? "SOURCE_REPORTED" : "UNKNOWN",
      payload: {
        relationType: "SUBAGENT_OF",
        childThreadIdentity: sha256(thread.id),
        parentThreadIdentity: sha256(parentThreadId),
      },
    });
  }
  thread.turns.forEach((turn, turnIndex) => {
    const occurredAt = itemTimestamp(turn);
    turn.items.forEach((item, itemIndex) => {
      const itemIdentity = sha256(item.id ?? canonicalJson({ turnIndex, itemIndex, item }));
      const role = messageRole(item);
      if (role) {
        add({
          stableKey: `message:${turnIndex}:${itemIndex}:${itemIdentity}`,
          kind: "CONTENT",
          dataClassification: "CONVERSATION_CONTENT",
          occurredAt,
          timeQuality: occurredAt ? "SOURCE_REPORTED" : "ORDER_ONLY",
          payload: {
            role,
            contentIdentity: sha256(canonicalJson(item)),
            sourceMessageIdentity: itemIdentity,
          },
        });
      }
      const tool = toolName(item);
      if (tool) {
        add({
          stableKey: `tool-occurrence:${turnIndex}:${itemIndex}:${itemIdentity}`,
          kind: "EVENT",
          dataClassification: "TOOL_CONTENT",
          occurredAt,
          timeQuality: occurredAt ? "SOURCE_REPORTED" : "ORDER_ONLY",
          payload: {
            toolName: tool,
            usageOccurrenceId: stableId("usage", { revisionId, itemIdentity }),
            contentIdentity: sha256(canonicalJson(item)),
          },
        });
      }
      if (item.type === "contextCompaction") {
        add({
          stableKey: `compaction:${turnIndex}:${itemIndex}:${itemIdentity}`,
          kind: "EVENT",
          dataClassification: "LOCAL_METADATA",
          occurredAt,
          timeQuality: occurredAt ? "SOURCE_REPORTED" : "ORDER_ONLY",
          payload: { eventType: "CONTEXT_COMPACTION" },
        });
      }
    });
  });
  return observations;
}
