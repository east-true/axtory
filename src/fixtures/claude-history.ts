import { canonicalJson, sha256, stableId } from "../core/canonical-json.js";
import type { NormalizedObservation } from "../core/records.js";

export const FIXTURE_SCHEMA = "axtory.fixture.claude-history.v1";
export const FIXTURE_NORMALIZER_VERSION = "fixture-claude-history/1";

interface FixtureBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  output?: unknown;
}

interface FixtureMessage {
  id: string;
  role: "user" | "assistant" | "system";
  occurredAt?: string;
  blocks: FixtureBlock[];
}

export interface ClaudeHistoryFixture {
  schemaVersion: typeof FIXTURE_SCHEMA;
  sourceObjectKey: string;
  sourceModifiedAt?: string;
  scenario?: "NORMAL" | "RESUMED" | "COMPACTED" | "ACTIVE" | "CUSTOM_CONFIG";
  expectedCoverage?:
    | "COMPLETE_FOR_RETURNED_VIEW"
    | "PARTIAL_COMPACTION"
    | "PARTIAL_SOURCE_CHANGED";
  session: {
    id: string;
    messages: FixtureMessage[];
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseClaudeHistoryFixture(bytes: Uint8Array): ClaudeHistoryFixture {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new Error("fixture is not valid JSON", { cause: error });
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== FIXTURE_SCHEMA ||
      typeof parsed.sourceObjectKey !== "string" || !isRecord(parsed.session) ||
      typeof parsed.session.id !== "string" || !Array.isArray(parsed.session.messages)) {
    throw new Error(`fixture does not match ${FIXTURE_SCHEMA}`);
  }
  for (const message of parsed.session.messages) {
    if (!isRecord(message) || typeof message.id !== "string" ||
        !["user", "assistant", "system"].includes(String(message.role)) || !Array.isArray(message.blocks)) {
      throw new Error("fixture contains an invalid message envelope");
    }
    for (const block of message.blocks) {
      if (!isRecord(block) || !["text", "tool_use", "tool_result"].includes(String(block.type))) {
        throw new Error("fixture contains an invalid content block");
      }
    }
  }
  return parsed as unknown as ClaudeHistoryFixture;
}

export function normalizeClaudeHistoryFixture(
  fixture: ClaudeHistoryFixture,
  revisionId: string,
): NormalizedObservation[] {
  const observations: NormalizedObservation[] = [];
  const add = (input: Omit<NormalizedObservation, "id" | "sourceRevisionId" | "derivation" | "provenance">) => {
    observations.push({
      ...input,
      id: stableId("obs", { revisionId, stableKey: input.stableKey }),
      sourceRevisionId: revisionId,
      derivation: "OBSERVED",
      provenance: "LOCAL_FILE",
    });
  };
  add({
    stableKey: "session",
    kind: "SNAPSHOT",
    dataClassification: "LOCAL_METADATA",
    occurredAt: null,
    timeQuality: "UNKNOWN",
    payload: {
      sourceConversationId: fixture.session.id,
      messageCoverage: fixture.expectedCoverage ?? "COMPLETE_FOR_RETURNED_VIEW",
    },
  });
  fixture.session.messages.forEach((message, messageIndex) => {
    const contentIdentity = sha256(canonicalJson(message.blocks));
    add({
      stableKey: `message:${messageIndex}:${message.id}`,
      kind: "CONTENT",
      dataClassification: "CONVERSATION_CONTENT",
      occurredAt: message.occurredAt ?? null,
      timeQuality: message.occurredAt ? "SOURCE_REPORTED" : "ORDER_ONLY",
      payload: { role: message.role, contentIdentity },
    });
    message.blocks.forEach((block, blockIndex) => {
      if (block.type !== "tool_use") return;
      add({
        stableKey: `tool-occurrence:${messageIndex}:${blockIndex}`,
        kind: "EVENT",
        dataClassification: "TOOL_CONTENT",
        occurredAt: message.occurredAt ?? null,
        timeQuality: message.occurredAt ? "SOURCE_REPORTED" : "ORDER_ONLY",
        payload: {
          toolName: block.toolName ?? "UNKNOWN",
          usageOccurrenceId: stableId("usage", { revisionId, messageIndex, blockIndex }),
          contentIdentity: sha256(canonicalJson(block.input ?? null)),
        },
      });
    });
  });
  return observations;
}
