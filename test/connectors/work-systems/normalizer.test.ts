import test from "node:test";
import assert from "node:assert/strict";

import { analyzeWorkFacts } from "../../../src/analysis/work-analyzer.js";
import { normalizeWorkArtifact } from "../../../src/connectors/work-systems/normalizer.js";
import { projectWorkArtifact } from "../../../src/projections/work-artifact.js";

test("work artifact normalization hashes Vendor and commit identities", () => {
  const observations = normalizeWorkArtifact({
    provider: "GITHUB", scopeIdentity: "a".repeat(64), kind: "CI_RUN", externalId: "private-run-id",
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z", sourceState: "success", statusCategory: "SUCCEEDED",
    commitLinks: [{ role: "SUBJECT", objectId: "private-commit-sha" }],
    sourceView: {},
  }, "revision");
  const encoded = JSON.stringify(observations);
  assert.equal(encoded.includes("private-run-id"), false);
  assert.equal(encoded.includes("private-commit-sha"), false);
  assert.equal(observations.filter((item) => item.kind === "RELATION").length, 1);
  assert.equal(observations[1]?.payload.relationType, "CI_RUN_COMMIT");
  const projection = projectWorkArtifact(observations);
  assert.equal(projection.statusCategory, "SUCCEEDED");
  const records = analyzeWorkFacts("analysis", [projection], ["CI_RUN"], "COMPLETE_FOR_RETURNED_VIEW");
  assert.equal(records.find((item) => item.key === "work.ci_run.succeeded.count")?.value, 1);
  assert.equal(records.find((item) => item.key === "work.deployment.count")?.availability, "NOT_SUPPORTED");
});

test("bounded work views preserve partial metric availability", () => {
  const records = analyzeWorkFacts("analysis", [], ["WORK_ITEM"], "PARTIAL_PAGINATION");
  const count = records.find((item) => item.key === "work.item.count");
  assert.equal(count?.value, 0);
  assert.equal(count?.availability, "PARTIAL");
});
