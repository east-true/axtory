import type { NormalizedObservation } from "../core/records.js";

export interface SessionProjection {
  sourceRevisionId: string;
  sessionEvidenceIds: readonly string[];
  messageEvidenceIds: readonly string[];
  toolInvocationEvidenceIds: readonly string[];
  messageCoverage:
    | "COMPLETE_FOR_RETURNED_VIEW"
    | "PARTIAL_PAGINATION"
    | "PARTIAL_COMPACTION"
    | "PARTIAL_SOURCE_CHANGED"
    | "PARTIAL_UNSETTLED_TURN"
    | "UNKNOWN";
}

export function projectSession(observations: readonly NormalizedObservation[]): SessionProjection {
  const sessionEvidenceIds = observations
    .filter((item) => item.stableKey === "session" && item.kind === "SNAPSHOT")
    .map((item) => item.id);
  if (sessionEvidenceIds.length !== 1) {
    throw new Error(`session projection requires exactly one session snapshot, found ${sessionEvidenceIds.length}`);
  }
  const sourceRevisionId = observations[0]?.sourceRevisionId;
  if (!sourceRevisionId || observations.some((item) => item.sourceRevisionId !== sourceRevisionId)) {
    throw new Error("session projection cannot mix source revisions");
  }
  const session = observations.find((item) => item.stableKey === "session");
  const coverage = session?.payload.messageCoverage;
  return {
    sourceRevisionId,
    sessionEvidenceIds,
    messageEvidenceIds: observations.filter((item) => item.kind === "CONTENT").map((item) => item.id),
    toolInvocationEvidenceIds: observations
      .filter((item) => item.stableKey.startsWith("tool-occurrence:"))
      .map((item) => item.id),
    messageCoverage: coverage === "COMPLETE_FOR_RETURNED_VIEW" || coverage === "PARTIAL_PAGINATION" ||
      coverage === "PARTIAL_COMPACTION" || coverage === "PARTIAL_SOURCE_CHANGED" ||
      coverage === "PARTIAL_UNSETTLED_TURN"
      ? coverage
      : "UNKNOWN",
  };
}
