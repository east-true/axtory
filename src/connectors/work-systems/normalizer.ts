import { sha256, stableId } from "../../core/canonical-json.js";
import type { NormalizedObservation } from "../../core/records.js";
import type { WorkArtifact } from "./types.js";

export const WORK_SYSTEM_NORMALIZER_VERSION = "work-system-artifact/1";

function relationType(kind: WorkArtifact["kind"]): string {
  if (kind === "CHANGE_REQUEST") return "CHANGE_REQUEST_COMMIT";
  if (kind === "CI_RUN") return "CI_RUN_COMMIT";
  if (kind === "DEPLOYMENT") return "DEPLOYMENT_COMMIT";
  return "UNKNOWN";
}

export function normalizeWorkArtifact(
  artifact: WorkArtifact,
  revisionId: string,
): NormalizedObservation[] {
  const base = {
    sourceRevisionId: revisionId,
    derivation: "OBSERVED" as const,
    provenance: "EXTERNAL_API" as const,
    dataClassification: "LOCAL_METADATA" as const,
  };
  const artifactIdentity = sha256(`${artifact.provider}:${artifact.scopeIdentity}:${artifact.kind}:${artifact.externalId}`);
  const snapshot: NormalizedObservation = {
    ...base,
    id: stableId("obs", { revisionId, stableKey: "artifact" }),
    stableKey: "artifact",
    kind: "SNAPSHOT",
    occurredAt: artifact.createdAt,
    timeQuality: artifact.createdAt ? "SOURCE_REPORTED" : "UNKNOWN",
    payload: {
      provider: artifact.provider,
      artifactKind: artifact.kind,
      artifactIdentity,
      scopeIdentity: artifact.scopeIdentity,
      sourceState: artifact.sourceState,
      statusCategory: artifact.statusCategory,
      sourceUpdatedAt: artifact.sourceUpdatedAt,
      completedAt: artifact.completedAt,
      commitLinkCount: artifact.commitLinks.length,
    },
  };
  const relations = artifact.commitLinks.map((link, index): NormalizedObservation => {
    const commitIdentity = sha256(link.objectId);
    const stableKey = `commit-relation:${index}:${link.role}:${commitIdentity}`;
    return {
      ...base,
      id: stableId("obs", { revisionId, stableKey }),
      stableKey,
      kind: "RELATION",
      occurredAt: artifact.sourceUpdatedAt,
      timeQuality: artifact.sourceUpdatedAt ? "SOURCE_REPORTED" : "UNKNOWN",
      payload: {
        relationType: relationType(artifact.kind),
        role: link.role,
        artifactIdentity,
        commitIdentity,
      },
    };
  });
  return [snapshot, ...relations];
}
