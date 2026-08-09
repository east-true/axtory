import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateUsageReport } from "../../src/analysis/usage-report.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

const collectedAt = "2026-08-09T00:00:00.000Z";

/** Seed `count` semantic-eligible session revisions under one completed collection run. */
function seedEligibleSessions(databasePath: string, count: number): void {
  const database = new AxtoryDatabase(databasePath);
  try {
    database.startCollectionRun("collection_seed", "FIXTURE", collectedAt);
    database.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const sourceObjectId = `source_seed_${index}`;
        const revisionId = `revision_seed_${index}`;
        database.upsertSourceObject(sourceObjectId, "FIXTURE", `session-${index}`);
        database.insertRevision({
          id: revisionId, sourceObjectId, contentHash: `hash_${index}`, collectedAt,
          sourceModifiedAt: null, normalizerVersion: "fixture-claude-history/1",
          payloadReference: `sha256/aa/hash_${index}`,
        });
        database.insertRawObservation({
          id: `raw_seed_${index}`, sourceRevisionId: revisionId, observationType: "FIXTURE_DOCUMENT",
          provenance: "LOCAL_FILE", dataClassification: "CONVERSATION_CONTENT",
          payloadReference: `sha256/aa/hash_${index}`, observedAt: collectedAt, sourceModifiedAt: null,
        });
        database.insertObservations([{
          id: `obs_seed_session_${index}`, sourceRevisionId: revisionId, stableKey: "session",
          kind: "SNAPSHOT", derivation: "OBSERVED", provenance: "LOCAL_FILE",
          dataClassification: "LOCAL_METADATA", occurredAt: collectedAt, timeQuality: "SOURCE_REPORTED",
          payload: { messageCoverage: "COMPLETE_FOR_RETURNED_VIEW" },
        }]);
        database.linkCollectionRevision("collection_seed", sourceObjectId, revisionId, collectedAt);
      }
    });
    database.finishCollectionRun("collection_seed", "COMPLETED", collectedAt);
  } finally {
    database.close();
  }
}

test("a rejected usage report still releases the database handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-lifecycle-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(directory, "data"));
    const databasePath = join(dataDirectory, "axtory.sqlite3");
    // The opt-in semantic path refuses more than 100 eligible revisions. That documented rejection
    // happens long before the report reaches its own try/finally, so the handle must be released by
    // an enclosing guard rather than leaked for the rest of the process.
    seedEligibleSessions(databasePath, 101);

    await assert.rejects(() => generateUsageReport({
      dataDirectory, jsonOutputPath: join(directory, "usage.json"), allowConversationContent: true,
    }), /limited to 100 revisions/u);

    // A leaked handle keeps the write lock, so an immediate exclusive write proves it was closed.
    const database = new AxtoryDatabase(databasePath);
    try {
      database.transaction(() => database.startCollectionRun("collection_probe", "FIXTURE", collectedAt));
    } finally {
      database.close();
    }

    // The successful path must remain closable too.
    const report = await generateUsageReport({
      dataDirectory, jsonOutputPath: join(directory, "usage.json"),
    });
    assert.equal(report.totals.sessions, 101);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
