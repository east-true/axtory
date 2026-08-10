import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { generateUsageReport } from "../../src/analysis/usage-report.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";
import { AxtoryDatabase } from "../../src/core/storage.js";
import type { NormalizedObservation } from "../../src/core/records.js";

// SQLite rejects a statement carrying more than 32766 host parameters. Evidence lists are built
// from every selected message and tool occurrence, so a database with a few hundred real sessions
// crosses that line and every `IN (?, ?, …)` lookup has to keep working past it.
const OBSERVATIONS_ABOVE_PARAMETER_LIMIT = 40_000;
const at = "2026-08-09T00:00:00.000Z";

function seed(databasePath: string): { revisionId: string; firstMessageEvidenceId: string } {
  const database = new AxtoryDatabase(databasePath);
  try {
    database.startCollectionRun("collection_scale", "FIXTURE", at);
    const observations: NormalizedObservation[] = [{
      id: "obs_session", sourceRevisionId: "revision_scale", stableKey: "session", kind: "SNAPSHOT",
      derivation: "OBSERVED", provenance: "LOCAL_FILE", dataClassification: "LOCAL_METADATA",
      occurredAt: at, timeQuality: "SOURCE_REPORTED",
      payload: { messageCoverage: "COMPLETE_FOR_RETURNED_VIEW" },
    }];
    for (let index = 0; index < OBSERVATIONS_ABOVE_PARAMETER_LIMIT; index += 1) {
      observations.push({
        id: `obs_message_${index}`, sourceRevisionId: "revision_scale",
        stableKey: `message:${index}:synthetic`, kind: "CONTENT", derivation: "OBSERVED",
        provenance: "LOCAL_FILE", dataClassification: "CONVERSATION_CONTENT",
        occurredAt: at, timeQuality: "SOURCE_REPORTED", payload: { role: "user" },
      });
    }
    database.transaction(() => {
      database.upsertSourceObject("source_scale", "FIXTURE", "scale-session");
      database.insertRevision({
        id: "revision_scale", sourceObjectId: "source_scale", contentHash: "hash_scale",
        collectedAt: at, sourceModifiedAt: null, normalizerVersion: "fixture-claude-history/1",
        payloadReference: "sha256/aa/hash_scale",
      });
      database.insertObservations(observations);
      database.linkCollectionRevision("collection_scale", "source_scale", "revision_scale", at);
    });
    database.finishCollectionRun("collection_scale", "COMPLETED", at);
    return { revisionId: "revision_scale", firstMessageEvidenceId: "obs_message_0" };
  } finally {
    database.close();
  }
}

test("a usage report survives an evidence list larger than the SQL parameter limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-parameter-limit-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(directory, "data"));
    const { revisionId } = seed(join(dataDirectory, "axtory.sqlite3"));

    const annotations = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
    try {
      annotations.insertUserAnnotation({
        id: "annotation_scale", targetType: "SOURCE_REVISION", targetId: revisionId,
        assertion: "a synthetic baseline claim", dataClassification: "LOCAL_METADATA",
        baselineMinutes: 30, createdAt: at,
      });
    } finally {
      annotations.close();
    }

    const report = await generateUsageReport({
      dataDirectory, jsonOutputPath: join(directory, "usage.json"),
    });

    assert.equal(report.totals.messages, OBSERVATIONS_ABOVE_PARAMETER_LIMIT);
    // The annotation attached to the selected revision must be counted exactly once, not once per
    // batch the evidence list was split into.
    assert.equal(report.annotations.sourceRevisionRecords, 1);
    assert.equal(report.annotations.records, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selective deletion survives a revision-scoped list larger than the parameter limit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-parameter-delete-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(directory, "data"));
    seed(join(dataDirectory, "axtory.sqlite3"));
    const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
    try {
      const evidenceIds = Array.from(
        { length: OBSERVATIONS_ABOVE_PARAMETER_LIMIT }, (_value, index) => `obs_message_${index}`,
      );
      assert.deepEqual(database.verificationRecordsForEvidenceIds(evidenceIds), []);
      assert.deepEqual(database.declaredBaselinesForScope([], evidenceIds), []);
      assert.equal(database.deleteRawObservations(evidenceIds), 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
