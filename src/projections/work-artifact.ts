import type { NormalizedObservation } from "../core/records.js";
import type { WorkArtifactKind, WorkStatusCategory } from "../connectors/work-systems/types.js";

export interface WorkArtifactProjection {
  sourceRevisionId: string;
  artifactKind: WorkArtifactKind;
  statusCategory: WorkStatusCategory;
  artifactEvidenceId: string;
  relationEvidenceIds: readonly string[];
}

export function projectWorkArtifact(observations: readonly NormalizedObservation[]): WorkArtifactProjection {
  const snapshots = observations.filter((item) => item.stableKey === "artifact" && item.kind === "SNAPSHOT");
  if (snapshots.length !== 1) {
    throw new Error(`work artifact projection requires exactly one artifact snapshot, found ${snapshots.length}`);
  }
  const snapshot = snapshots[0]!;
  if (observations.some((item) => item.sourceRevisionId !== snapshot.sourceRevisionId)) {
    throw new Error("work artifact projection cannot mix source revisions");
  }
  const artifactKind = snapshot.payload.artifactKind;
  const statusCategory = snapshot.payload.statusCategory;
  if (!isArtifactKind(artifactKind) || !isStatusCategory(statusCategory)) {
    throw new Error("work artifact snapshot has invalid canonical fields");
  }
  return {
    sourceRevisionId: snapshot.sourceRevisionId,
    artifactKind,
    statusCategory,
    artifactEvidenceId: snapshot.id,
    relationEvidenceIds: observations.filter((item) => item.kind === "RELATION").map((item) => item.id),
  };
}

function isArtifactKind(value: unknown): value is WorkArtifactKind {
  return value === "CHANGE_REQUEST" || value === "CI_RUN" || value === "DEPLOYMENT" || value === "WORK_ITEM";
}

function isStatusCategory(value: unknown): value is WorkStatusCategory {
  return ["OPEN", "MERGED", "CLOSED", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELED",
    "COMPLETED", "BACKLOG", "UNKNOWN"].includes(String(value));
}
