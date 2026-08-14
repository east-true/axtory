import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { stableId } from "../../src/core/canonical-json.js";
import { replaceDerivedEvidenceAtomically } from "../../src/core/derived-storage.js";
import type { AnalysisRecord, NormalizedObservation } from "../../src/core/records.js";
import { persistCollectedRevision } from "../../src/core/revision-persistence.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

function observation(revisionId: string, key = "session"): NormalizedObservation {
  return {
    id: stableId("obs", { revisionId, key }), sourceRevisionId: revisionId,
    stableKey: key, kind: "SNAPSHOT", derivation: "OBSERVED", provenance: "OFFICIAL_API",
    dataClassification: "LOCAL_METADATA", occurredAt: null, timeQuality: "UNKNOWN",
    payload: { messageCoverage: "COMPLETE_FOR_RETURNED_VIEW", marker: key },
  };
}

test("a collected revision cannot commit its header without the evidence bundle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-revision-atomic-"));
  const databasePath = join(directory, "axtory.sqlite3");
  const database = new AxtoryDatabase(databasePath);
  try {
    database.startCollectionRun("collection_1", "CLAUDE_CODE", "2026-08-14T00:00:00.000Z");
    await assert.rejects(async () => {
      persistCollectedRevision(database, {
        collectionRunId: "collection_1",
        sourceObject: { id: "source_1", sourceType: "CLAUDE_CODE", externalKey: "session_1" },
        revision: {
          id: "revision_1", sourceObjectId: "source_1", contentHash: "a".repeat(64),
          collectedAt: "2026-08-14T00:00:00.000Z", sourceModifiedAt: null,
          normalizerVersion: "test/1", payloadReference: "sha256/aa/" + "a".repeat(64),
        },
        rawObservation: {
          id: "raw_1", sourceRevisionId: "revision_1", observationType: "VENDOR_SESSION_VIEW",
          provenance: "OFFICIAL_API", dataClassification: "CONVERSATION_CONTENT",
          payloadReference: "sha256/aa/" + "a".repeat(64), observedAt: "2026-08-14T00:00:00.000Z",
          sourceModifiedAt: null,
        },
        // The mismatched FK deliberately makes the final bundle fail after source/revision/raw writes.
        observations: [observation("missing_revision")],
        observedAt: "2026-08-14T00:00:00.000Z",
      });
    });
    assert.equal(database.count("source_objects"), 0);
    assert.equal(database.count("source_revisions"), 0);
    assert.equal(database.count("raw_observations"), 0);
    assert.equal(database.count("normalized_observations"), 0);
    assert.equal(database.count("collection_revision_observations"), 0);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("renormalized evidence and dependent invalidation roll back together", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-renormalize-atomic-"));
  const databasePath = join(directory, "axtory.sqlite3");
  const database = new AxtoryDatabase(databasePath);
  const original = observation("revision_1", "session");
  try {
    database.upsertSourceObject("source_1", "CODEX", "thread_1");
    database.insertRevision({
      id: "revision_1", sourceObjectId: "source_1", contentHash: "b".repeat(64),
      collectedAt: "2026-08-14T00:00:00.000Z", sourceModifiedAt: null,
      normalizerVersion: "old/1", payloadReference: "sha256/bb/" + "b".repeat(64),
    });
    database.insertObservations([original]);
    database.startAnalysisRun({
      id: "analysis_1", analyzerType: "FACT_ANALYZER", analyzerVersion: "old/1",
      inputRevisionIds: ["revision_1"], startedAt: "2026-08-14T00:00:00.000Z",
    });
    database.insertAnalysisRecords([{
      id: "analysis_record_1", analysisRunId: "analysis_1", key: "session.count", recordType: "METRIC",
      derivation: "CALCULATED", value: 1, unit: "count", availability: "AVAILABLE", reason: null,
      evidenceIds: [original.id], evidenceStatus: "PRESENT",
    } satisfies AnalysisRecord]);
    database.finishAnalysisRun("analysis_1", "COMPLETED", "2026-08-14T00:01:00.000Z");
  } finally {
    database.close();
  }

  const sqlite = new DatabaseSync(databasePath);
  try {
    sqlite.exec(`CREATE TRIGGER reject_invalidation BEFORE UPDATE OF evidence_status ON analysis_records
      WHEN NEW.evidence_status = 'INVALIDATED'
      BEGIN SELECT RAISE(ABORT, 'synthetic invalidation failure'); END;`);
  } finally {
    sqlite.close();
  }

  try {
    assert.throws(() => replaceDerivedEvidenceAtomically({
      databasePath,
      revisionId: "revision_1",
      observations: [observation("revision_1", "replacement")],
      normalizerVersion: "new/1",
    }), /synthetic invalidation failure/u);

    const check = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const version = check.prepare("SELECT normalizer_version FROM source_revisions WHERE id = 'revision_1'")
        .get() as { normalizer_version: string };
      const rows = check.prepare("SELECT stable_key FROM normalized_observations WHERE source_revision_id = 'revision_1'")
        .all() as Array<{ stable_key: string }>;
      const analysis = check.prepare("SELECT evidence_status FROM analysis_records WHERE id = 'analysis_record_1'")
        .get() as { evidence_status: string };
      assert.equal(version.normalizer_version, "old/1");
      assert.deepEqual(rows.map((row) => row.stable_key), ["session"]);
      assert.equal(analysis.evidence_status, "PRESENT");
    } finally {
      check.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
