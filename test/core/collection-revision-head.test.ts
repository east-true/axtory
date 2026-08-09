import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { stableId } from "../../src/core/canonical-json.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

test("latest revision follows the latest completed observation when content reverts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-head-"));
  try {
    const initial = await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "fixture.json"),
      now: () => new Date("2026-01-02T04:00:00.000Z"), randomId: () => "head-fixture",
    });
    const sourceObjectId = stableId("source", { sourceType: "FIXTURE", key: "synthetic-normal-session" });
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      database.insertRevision({
        id: "revision_new_content", sourceObjectId, contentHash: "e".repeat(64),
        collectedAt: "2026-02-01T00:00:00.000Z", sourceModifiedAt: null,
        normalizerVersion: "usage-test/1", payloadReference: "blobs/new",
      });
      database.startCollectionRun("collection_new", "FIXTURE", "2026-02-01T00:00:00.000Z");
      database.linkCollectionRevision(
        "collection_new", sourceObjectId, "revision_new_content", "2026-02-01T00:00:00.000Z",
      );
      database.finishCollectionRun("collection_new", "COMPLETED", "2026-02-01T00:01:00.000Z");
      database.startCollectionRun("collection_failed_revert", "FIXTURE", "2026-02-02T00:00:00.000Z");
      database.linkCollectionRevision(
        "collection_failed_revert", sourceObjectId, initial.output.sourceRevisionId, "2026-02-02T00:00:00.000Z",
      );
      database.finishCollectionRun("collection_failed_revert", "FAILED", "2026-02-02T00:01:00.000Z");
      assert.equal(database.latestRevisions()[0]?.revisionId, "revision_new_content");
      database.startCollectionRun("collection_completed_revert", "FIXTURE", "2026-02-03T00:00:00.000Z");
      database.linkCollectionRevision(
        "collection_completed_revert", sourceObjectId, initial.output.sourceRevisionId, "2026-02-03T00:00:00.000Z",
      );
      database.finishCollectionRun("collection_completed_revert", "COMPLETED", "2026-02-03T00:01:00.000Z");
      assert.equal(database.latestRevisions()[0]?.revisionId, initial.output.sourceRevisionId);
      database.upsertSourceObject("source_failed_only", "CODEX", "failed-only");
      database.insertRevision({
        id: "revision_failed_only", sourceObjectId: "source_failed_only", contentHash: "d".repeat(64),
        collectedAt: "2026-02-04T00:00:00.000Z", sourceModifiedAt: null,
        normalizerVersion: "usage-test/1", payloadReference: "blobs/failed",
      });
      database.startCollectionRun("collection_failed_only", "CODEX", "2026-02-04T00:00:00.000Z");
      database.linkCollectionRevision(
        "collection_failed_only", "source_failed_only", "revision_failed_only", "2026-02-04T00:00:00.000Z",
      );
      database.finishCollectionRun("collection_failed_only", "FAILED", "2026-02-04T00:01:00.000Z");
      assert.equal(database.latestRevisions().some((item) => item.sourceObjectId === "source_failed_only"), false);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
