import { stableId } from "../core/canonical-json.js";
import type { AnalysisRecord, NormalizedObservation } from "../core/records.js";

export const WORK_GIT_CORRELATION_VERSION = "explicit-commit-identity/1";

export function correlateWorkWithGit(
  analysisRunId: string,
  workObservations: readonly NormalizedObservation[],
  gitObservations: readonly NormalizedObservation[],
): AnalysisRecord[] {
  const gitCommits = new Map<string, NormalizedObservation>();
  for (const observation of gitObservations) {
    if (!observation.stableKey.startsWith("commit:")) continue;
    const identity = observation.payload.commitIdentity;
    if (typeof identity === "string") gitCommits.set(identity, observation);
  }

  return workObservations
    .filter((observation) => observation.kind === "RELATION")
    .flatMap((relation) => {
      const commitIdentity = relation.payload.commitIdentity;
      if (typeof commitIdentity !== "string") return [];
      const commit = gitCommits.get(commitIdentity);
      if (!commit) return [];
      const key = `relation.work-git.${relation.id}.${commit.id}`;
      return [{
        id: stableId("analysis", { analysisRunId, key }),
        analysisRunId,
        key,
        recordType: "RELATION",
        derivation: "OBSERVED",
        value: {
          relationType: "ARTIFACT_COMMIT_IN_REPOSITORY",
          workRevisionId: relation.sourceRevisionId,
          gitRevisionId: commit.sourceRevisionId,
        },
        unit: null,
        availability: "AVAILABLE",
        reason: "The work-system artifact and Local Git snapshot report the same hashed commit identity.",
        evidenceIds: [relation.id, commit.id],
        evidenceStatus: "PRESENT",
      } satisfies AnalysisRecord];
    });
}
