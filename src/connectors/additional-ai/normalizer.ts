import { stableId } from "../../core/canonical-json.js";
import type { NormalizedObservation } from "../../core/records.js";
import type { AdditionalAiSessionView } from "./types.js";

export const ADDITIONAL_AI_NORMALIZER_VERSION = "additional-ai-session/2";

function projectionCoverage(view: AdditionalAiSessionView): "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION" | "PARTIAL_COMPACTION" | "PARTIAL_SOURCE_CHANGED" | "UNKNOWN" {
  if (view.coverage === "COMPLETE_FOR_RETURNED_VIEW") return "COMPLETE_FOR_RETURNED_VIEW";
  if (view.coverage === "PARTIAL_LIMIT") return "PARTIAL_PAGINATION";
  if (view.coverage === "PARTIAL_COMPACTION") return "PARTIAL_COMPACTION";
  if (view.coverage === "PARTIAL_SOURCE_CHANGED") return "PARTIAL_SOURCE_CHANGED";
  return "UNKNOWN";
}

export function normalizeAdditionalAiSession(
  view: AdditionalAiSessionView,
  revisionId: string,
): NormalizedObservation[] {
  const base = {
    sourceRevisionId: revisionId,
    derivation: "OBSERVED" as const,
    provenance: view.provenance,
    dataClassification: view.dataClassification,
  };
  const session: NormalizedObservation = {
    ...base,
    id: stableId("obs", { revisionId, stableKey: "session" }),
    stableKey: "session", kind: "SNAPSHOT",
    occurredAt: view.summary.createdAt,
    timeQuality: view.summary.createdAt ? "SOURCE_REPORTED" : "UNKNOWN",
    payload: {
      provider: view.summary.provider,
      sessionIdentity: stableId("additional-ai-session", {
        provider: view.summary.provider, scopeIdentity: view.summary.scopeIdentity,
        externalId: view.summary.externalId,
      }),
      sourceUpdatedAt: view.summary.sourceUpdatedAt,
      additionalAiCoverage: view.coverage,
      messageCoverage: projectionCoverage(view),
      returnedMessageCount: view.messages.length,
      ...(view.summary.workspaceIdentity
        ? { workspaceIdentity: view.summary.workspaceIdentity }
        : {}),
    },
  };
  const messages = view.messages.map((message, index): NormalizedObservation => {
    const stableKey = `message:${index}:${stableId("message", message.externalId)}`;
    return {
      ...base,
      id: stableId("obs", { revisionId, stableKey }), stableKey, kind: "CONTENT",
      occurredAt: message.occurredAt,
      timeQuality: message.occurredAt ? "SOURCE_REPORTED" : "UNKNOWN",
      payload: {
        role: message.role, contentIdentity: message.contentIdentity,
        partTypes: message.partTypes,
      },
    };
  });
  const tools = view.messages.flatMap((message, messageIndex) => message.partTypes.flatMap((partType, partIndex) => {
    if (partType !== "tool") return [];
    const stableKey = `tool-occurrence:${messageIndex}:${partIndex}`;
    return [{
      ...base,
      id: stableId("obs", { revisionId, stableKey }), stableKey, kind: "EVENT" as const,
      occurredAt: message.occurredAt,
      timeQuality: message.occurredAt ? "SOURCE_REPORTED" as const : "UNKNOWN" as const,
      payload: { provider: view.summary.provider, toolType: "tool" },
    }];
  }));
  return [session, ...messages, ...tools];
}
