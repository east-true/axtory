import test from "node:test";
import assert from "node:assert/strict";

import { correlateWorkWithGit } from "../../src/analysis/work-git-correlation.js";
import type { NormalizedObservation } from "../../src/core/records.js";

function observation(
  id: string,
  sourceRevisionId: string,
  stableKey: string,
  kind: NormalizedObservation["kind"],
  payload: Record<string, unknown>,
): NormalizedObservation {
  return {
    id, sourceRevisionId, stableKey, kind, payload,
    derivation: "OBSERVED", provenance: "EXTERNAL_API", dataClassification: "LOCAL_METADATA",
    occurredAt: null, timeQuality: "UNKNOWN",
  };
}

test("work-to-Git correlation requires an explicit identical commit identity", () => {
  const work = [
    observation("work-match", "work-rev", "commit-relation:0", "RELATION", { commitIdentity: "same" }),
    observation("work-miss", "work-rev", "commit-relation:1", "RELATION", { commitIdentity: "other" }),
  ];
  const git = [observation("git-match", "git-rev", "commit:0:same", "EVENT", { commitIdentity: "same" })];
  const records = correlateWorkWithGit("run", work, git);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.derivation, "OBSERVED");
  assert.deepEqual(records[0]?.evidenceIds, ["work-match", "git-match"]);
  assert.deepEqual(records[0]?.value, {
    relationType: "ARTIFACT_COMMIT_IN_REPOSITORY",
    workRevisionId: "work-rev",
    gitRevisionId: "git-rev",
  });
});
