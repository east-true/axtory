import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectWorkSystem } from "../../../src/connectors/work-systems/collector.js";
import { discoverWorkSystem, type WorkArtifact, type WorkSystemApi } from "../../../src/connectors/work-systems/types.js";
import { sha256 } from "../../../src/core/canonical-json.js";
import { AxtoryDatabase } from "../../../src/core/storage.js";

const scopeIdentity = "b".repeat(64);

function issue(secret: string): WorkArtifact {
  return {
    provider: "JIRA", scopeIdentity, kind: "WORK_ITEM", externalId: "issue-private",
    sourceUpdatedAt: "2026-01-02T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:00.000Z", sourceState: "done", statusCategory: "COMPLETED",
    commitLinks: [{ role: "SUBJECT", objectId: "explicit-commit" }],
    sourceView: { schemaVersion: "synthetic", id: "issue-private", opaque: secret },
  };
}

test("work-system collection is incremental and exports only aggregate evidence", async () => {
  const secret = "PRIVATE-WORK-ITEM-CONTENT";
  const api: WorkSystemApi = {
    provider: "JIRA", scopeIdentity, supportedKinds: ["WORK_ITEM"],
    async listArtifacts() { return { items: [issue(secret)], nextCursor: null }; },
  };
  const discovery = discoverWorkSystem({
    provider: "JIRA", scopeIdentity, hasCredential: true, supportedKinds: api.supportedKinds,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });
  const directory = await mkdtemp(join(tmpdir(), "axtory-work-system-"));
  try {
    let sequence = 0;
    const run = () => collectWorkSystem(api, discovery, {
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"),
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => `id-${++sequence}`,
    });
    const first = await run();
    const setup = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      setup.upsertSourceObject("git-source", "LOCAL_GIT", "repository-identity");
      setup.insertRevision({
        id: "git-revision", sourceObjectId: "git-source", contentHash: "c".repeat(64),
        collectedAt: "2026-08-09T00:00:00.000Z", sourceModifiedAt: null,
        normalizerVersion: "test", payloadReference: "test",
      });
      setup.insertObservations([{
        id: "git-commit", sourceRevisionId: "git-revision",
        stableKey: `commit:0:${sha256("explicit-commit")}`, kind: "EVENT", derivation: "OBSERVED",
        provenance: "LOCAL_FILE", dataClassification: "LOCAL_METADATA", occurredAt: null,
        timeQuality: "UNKNOWN", payload: { commitIdentity: sha256("explicit-commit") },
      }]);
    } finally {
      setup.close();
    }
    const second = await collectWorkSystem(api, discovery, {
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"), gitRevisionId: "git-revision",
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => `id-${++sequence}`,
    });
    assert.equal(first.artifacts.revisionsCreated, 1);
    assert.equal(second.artifacts.revisionsCreated, 0);
    assert.equal(second.artifacts.revisionsUnchanged, 1);
    assert.equal(second.artifacts.byKind.WORK_ITEM, 1);
    assert.equal(second.artifacts.byKind.CI_RUN, null);
    assert.equal(second.metrics.find((item) => item.key === "work.item.completed.count")?.value, 1);
    assert.equal(second.metrics.find((item) => item.key === "work.ci_run.count")?.availability, "NOT_SUPPORTED");
    assert.deepEqual(second.repositoryLinks, { matched: 1, derivation: "OBSERVED" });
    assert.equal((await readFile(join(directory, "output.json"), "utf8")).includes(secret), false);
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.equal(database.count("source_revisions"), 2);
      assert.equal(database.count("raw_observations"), 1);
      assert.equal(database.count("analysis_runs"), 2);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
