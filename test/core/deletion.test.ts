import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { applyRetention, executeSelectiveDeletion } from "../../src/core/deletion.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "../../src/core/policy.js";
import { AxtoryDatabase } from "../../src/core/storage.js";
import { BoundedSpool } from "../../src/live/spool.js";

async function collected(directory: string, now = "2026-08-01T00:00:00.000Z") {
  let sequence = 0;
  return runWalkingSkeleton({
    fixturePath: resolve("fixtures/synthetic/normal-session.json"),
    dataDirectory: directory,
    jsonOutputPath: join(directory, "output.json"),
    now: () => new Date(now),
    randomId: () => `deletion-test-${++sequence}`,
  });
}

test("raw-only deletion removes unreferenced blobs and marks dependent evidence removed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-delete-raw-"));
  try {
    const run = await collected(directory);
    const sqlite = new DatabaseSync(run.databasePath);
    const raw = sqlite.prepare(`SELECT payload_reference FROM raw_observations`).get() as
      { payload_reference: string };
    const analysis = sqlite.prepare(`SELECT id FROM analysis_records ORDER BY id LIMIT 1`).get() as { id: string };
    sqlite.close();
    const database = new AxtoryDatabase(run.databasePath);
    database.insertUserAnnotation({
      id: "annotation-1", targetType: "ANALYSIS_RECORD", targetId: analysis.id,
      assertion: "This result was useful.", dataClassification: "PERSONAL_DATA", baselineMinutes: null,
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    database.insertVerificationRecord({
      id: "verification-1", analysisRecordId: analysis.id, verificationType: "HUMAN_ACCEPTANCE",
      status: "VERIFIED", provenance: "USER_PROVIDED", evidenceIds: [], note: null,
      verifiedAt: "2026-08-02T00:00:00.000Z",
    });
    database.close();

    await assert.rejects(() => executeSelectiveDeletion({
      dataDirectory: directory, mode: "DELETE_RAW_ONLY", target: { revisionIds: [run.output.sourceRevisionId] },
      confirmation: "wrong",
    }), /requires --confirm DELETE_RAW_ONLY/u);
    const result = await executeSelectiveDeletion({
      dataDirectory: directory, mode: "DELETE_RAW_ONLY", target: { revisionIds: [run.output.sourceRevisionId] },
      confirmation: "DELETE_RAW_ONLY", now: () => new Date("2026-08-03T00:00:00.000Z"),
      randomId: () => "raw-only",
    });
    assert.deepEqual(result, {
      mode: "DELETE_RAW_ONLY", rawObservationsDeleted: 1, normalizedObservationsDeleted: 0,
      analysisRunsDeleted: 0, blobsDeleted: 1, spoolEntriesDeleted: 0, annotationsDeleted: 0,
    });
    await assert.rejects(access(join(directory, "blobs", raw.payload_reference)));
    const verifier = new DatabaseSync(run.databasePath, { readOnly: true });
    try {
      assert.equal((verifier.prepare(`SELECT COUNT(*) AS count FROM raw_observations`).get() as { count: number }).count, 0);
      assert.equal((verifier.prepare(`SELECT COUNT(*) AS count FROM normalized_observations`).get() as { count: number }).count, 6);
      assert.equal((verifier.prepare(`SELECT COUNT(*) AS count FROM analysis_records
        WHERE evidence_status = 'EVIDENCE_REMOVED'`).get() as { count: number }).count, 3);
      assert.equal((verifier.prepare(`SELECT COUNT(*) AS count FROM verification_records`).get() as { count: number }).count, 1);
      assert.equal((verifier.prepare(`SELECT COUNT(*) AS count FROM user_annotations`).get() as { count: number }).count, 1);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw-and-derived deletion removes projections and analysis runs but retains revision identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-delete-derived-"));
  try {
    const run = await collected(directory);
    const result = await executeSelectiveDeletion({
      dataDirectory: directory, mode: "DELETE_RAW_AND_DERIVED",
      target: { revisionIds: [run.output.sourceRevisionId] }, confirmation: "DELETE_RAW_AND_DERIVED",
      randomId: () => "raw-derived",
    });
    assert.equal(result.rawObservationsDeleted, 1);
    assert.equal(result.normalizedObservationsDeleted, 6);
    assert.equal(result.analysisRunsDeleted, 1);
    const database = new AxtoryDatabase(run.databasePath);
    try {
      assert.equal(database.count("source_revisions"), 1);
      assert.equal(database.count("normalized_observations"), 0);
      assert.equal(database.count("analysis_runs"), 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source-session deletion cascades source revisions and their derived runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-delete-source-"));
  try {
    const run = await collected(directory);
    const sqlite = new DatabaseSync(run.databasePath, { readOnly: true });
    const source = sqlite.prepare(`SELECT source_object_id FROM source_revisions WHERE id = ?`)
      .get(run.output.sourceRevisionId) as { source_object_id: string };
    sqlite.close();
    const spool = new BoundedSpool(join(directory, "spool"));
    await spool.append({
      channel: "CLAUDE_HOOK", receivedAt: "2026-08-02T00:00:00.000Z",
      payload: { session_id: "synthetic-normal-session", hook_event_name: "Stop" },
    });
    await spool.append({
      channel: "CLAUDE_OTEL_LOGS", receivedAt: "2026-08-02T00:00:00.000Z",
      payload: { resourceLogs: [{ resource: { attributes: [
        { key: "session.id", value: { stringValue: "synthetic-normal-session" } },
      ] } }] },
    });
    const result = await executeSelectiveDeletion({
      dataDirectory: directory, mode: "DELETE_SOURCE_SESSION", target: { sourceObjectId: source.source_object_id },
      confirmation: "DELETE_SOURCE_SESSION", randomId: () => "source-session",
    });
    assert.equal(result.rawObservationsDeleted, 1);
    assert.equal(result.spoolEntriesDeleted, 2);
    assert.equal((await spool.listPending()).length, 0);
    const database = new AxtoryDatabase(run.databasePath);
    try {
      assert.equal(database.count("source_objects"), 0);
      assert.equal(database.count("source_revisions"), 0);
      assert.equal(database.count("analysis_runs"), 0);
      assert.equal(database.count("deletion_runs"), 1);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention persists its policy and deletes only observations older than the cutoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-retention-"));
  try {
    await collected(directory, "2026-08-01T00:00:00.000Z");
    const policy = {
      ...DEFAULT_LOCAL_COLLECTION_POLICY,
      version: "test-retention/1",
      classifications: {
        ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications,
        CONVERSATION_CONTENT: {
          ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications.CONVERSATION_CONTENT,
          retentionDays: 7,
        },
        TOOL_CONTENT: {
          ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications.TOOL_CONTENT,
          retentionDays: 7,
        },
      },
    };
    const spool = new BoundedSpool(join(directory, "spool"));
    await spool.append({
      channel: "CLAUDE_HOOK", receivedAt: "2026-08-01T00:00:00.000Z",
      payload: { session_id: "retained-session", hook_event_name: "Stop" },
    });
    const result = await applyRetention({
      dataDirectory: directory, policy, now: () => new Date("2026-08-09T00:00:00.000Z"),
      randomId: () => "retention",
    });
    assert.equal(result.rawObservationsDeleted, 1);
    assert.equal(result.spoolEntriesDeleted, 1);
    assert.equal((await spool.listPending()).length, 0);
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.deepEqual(database.loadCollectionPolicy("test-retention/1"), policy);
      assert.equal(database.count("raw_observations"), 0);
      assert.equal(database.count("deletion_runs"), 1);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
