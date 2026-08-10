import test from "node:test";
import assert from "node:assert/strict";

import { enumerateWorkArtifacts } from "../../../src/connectors/work-systems/pagination.js";
import type { WorkArtifact, WorkArtifactKind, WorkSystemApi } from "../../../src/connectors/work-systems/types.js";

const scopeIdentity = "a".repeat(64);

function artifact(kind: WorkArtifactKind, externalId: string): WorkArtifact {
  return {
    provider: "GITHUB", scopeIdentity, kind, externalId,
    sourceUpdatedAt: "2026-01-01T00:00:00.000Z", createdAt: null, completedAt: null,
    sourceState: "open", statusCategory: "OPEN", commitLinks: [], sourceView: { id: externalId },
  };
}

test("work-system pagination enumerates every declared artifact kind", async () => {
  const calls: Array<{ kind: WorkArtifactKind; cursor?: string | null }> = [];
  const api: WorkSystemApi = {
    provider: "GITHUB", scopeIdentity, supportedKinds: ["CHANGE_REQUEST", "CI_RUN"],
    async listArtifacts(kind, options) {
      calls.push(options.cursor === undefined ? { kind } : { kind, cursor: options.cursor });
      if (kind === "CHANGE_REQUEST" && !options.cursor) {
        return { items: [artifact(kind, "1")], nextCursor: "next" };
      }
      return { items: [artifact(kind, kind === "CHANGE_REQUEST" ? "2" : "3")], nextCursor: null };
    },
  };
  const result = await enumerateWorkArtifacts(api);
  assert.equal(result.coverage, "COMPLETE_FOR_RETURNED_VIEW");
  assert.equal(result.items.length, 3);
  assert.deepEqual(calls.map((call) => call.kind), ["CHANGE_REQUEST", "CHANGE_REQUEST", "CI_RUN"]);
});

test("cursor loops and duplicate artifacts remain partial", async () => {
  const api: WorkSystemApi = {
    provider: "GITHUB", scopeIdentity, supportedKinds: ["CI_RUN"],
    async listArtifacts() { return { items: [artifact("CI_RUN", "same")], nextCursor: "loop" }; },
  };
  const result = await enumerateWorkArtifacts(api);
  assert.equal(result.coverage, "PARTIAL_PAGINATION");
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.items.length, 1);
});
