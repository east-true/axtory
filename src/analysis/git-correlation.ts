import { stableId } from "../core/canonical-json.js";
import type { AnalysisRecord, NormalizedObservation } from "../core/records.js";

export const GIT_CORRELATION_VERSION = "temporal-user-selected/1";

export function correlateGitWithSession(
  analysisRunId: string,
  sessionObservations: readonly NormalizedObservation[],
  gitObservations: readonly NormalizedObservation[],
  toleranceMilliseconds = 5 * 60 * 1000,
): AnalysisRecord[] {
  const messages = sessionObservations.filter((item) => item.kind === "CONTENT" && item.occurredAt);
  const times = messages.map((item) => Date.parse(item.occurredAt!)).filter(Number.isFinite);
  if (times.length === 0) return [];
  const start = Math.min(...times) - toleranceMilliseconds;
  const end = Math.max(...times) + toleranceMilliseconds;
  return gitObservations.filter((item) => item.stableKey.startsWith("commit:") && item.occurredAt &&
      Date.parse(item.occurredAt) >= start && Date.parse(item.occurredAt) <= end)
    .map((commit, index) => {
      const key = `relation.session-git.${index}.${commit.id}`;
      return {
        id: stableId("analysis", { analysisRunId, key }), analysisRunId, key,
        recordType: "RELATION", derivation: "INFERRED",
        value: {
          relationType: "TEMPORAL_REPOSITORY_CONTEXT",
          correlation: "CORRELATED",
          gitRevisionId: commit.sourceRevisionId,
          sessionRevisionId: sessionObservations[0]?.sourceRevisionId,
        },
        unit: null, availability: "AVAILABLE",
        reason: "A commit timestamp overlaps a user-selected session/repository window; authorship and causality are not established.",
        evidenceIds: [...messages.map((item) => item.id), commit.id], evidenceStatus: "PRESENT",
      } satisfies AnalysisRecord;
    });
}
