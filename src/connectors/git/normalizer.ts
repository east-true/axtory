import { sha256, stableId } from "../../core/canonical-json.js";
import type { NormalizedObservation } from "../../core/records.js";
import type { LocalGitSnapshot } from "./local-git.js";

export const GIT_NORMALIZER_VERSION = "local-git/1";

export function normalizeLocalGitSnapshot(
  snapshot: LocalGitSnapshot,
  revisionId: string,
): NormalizedObservation[] {
  const base = {
    sourceRevisionId: revisionId,
    derivation: "OBSERVED" as const,
    provenance: "LOCAL_FILE" as const,
    dataClassification: "LOCAL_METADATA" as const,
  };
  const repository: NormalizedObservation = {
    ...base,
    id: stableId("obs", { revisionId, stableKey: "repository" }),
    stableKey: "repository", kind: "SNAPSHOT", occurredAt: null, timeQuality: "UNKNOWN",
    payload: {
      repositoryIdentity: snapshot.repositoryIdentity,
      headIdentity: snapshot.headObjectId ? sha256(snapshot.headObjectId) : null,
      worktreeStateDigest: snapshot.worktreeStateDigest,
      dirty: snapshot.dirty,
      returnedCommitCount: snapshot.commits.length,
    },
  };
  return [repository, ...snapshot.commits.map((commit, index) => ({
    ...base,
    id: stableId("obs", { revisionId, stableKey: `commit:${index}:${sha256(commit.objectId)}` }),
    stableKey: `commit:${index}:${sha256(commit.objectId)}`,
    kind: "EVENT" as const,
    occurredAt: new Date(commit.committedAt).toISOString(),
    timeQuality: "SOURCE_REPORTED" as const,
    payload: {
      commitIdentity: sha256(commit.objectId),
      parentIdentities: commit.parentObjectIds.map(sha256),
      treeIdentity: sha256(commit.treeObjectId),
      authoredAt: new Date(commit.authoredAt).toISOString(),
    },
  }))];
}
