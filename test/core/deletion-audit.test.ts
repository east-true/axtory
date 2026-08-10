import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { applyRetention } from "../../src/core/deletion.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "../../src/core/policy.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

const at = "2026-06-01T00:00:00.000Z";

test("the deletion audit records cleared verification notes, not only deleted annotations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-deletion-audit-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(directory, "data"));
    const databasePath = join(dataDirectory, "axtory.sqlite3");
    const database = new AxtoryDatabase(databasePath);
    try {
      database.startAnalysisRun({
        id: "analysis_audit", analyzerType: "FACT_ANALYZER", analyzerVersion: "v1",
        inputRevisionIds: [], startedAt: at,
      });
      database.transaction(() => database.insertAnalysisRecords([{
        id: "record_audit", analysisRunId: "analysis_audit", key: "session.count",
        recordType: "METRIC", derivation: "CALCULATED", value: 1, unit: "count",
        availability: "AVAILABLE", reason: null, evidenceIds: [], evidenceStatus: "PRESENT",
      }]));
      database.finishAnalysisRun("analysis_audit", "COMPLETED", at);
      database.insertVerificationRecord({
        id: "verification_audit", analysisRecordId: "record_audit", verificationType: "TECHNICAL",
        status: "VERIFIED", provenance: "USER_PROVIDED", evidenceIds: [],
        note: "a synthetic note that retention should clear", noteClassification: "PERSONAL_DATA",
        verifiedAt: at,
      });
    } finally {
      database.close();
    }

    const result = await applyRetention({
      dataDirectory,
      policy: {
        ...DEFAULT_LOCAL_COLLECTION_POLICY,
        version: "local-retention/audit-test",
        classifications: {
          ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications,
          PERSONAL_DATA: {
            ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications.PERSONAL_DATA, retentionDays: 0,
          },
        },
      },
    });
    assert.equal(result.verificationNotesCleared, 1);

    // The returned count was already reported to the caller; the durable audit row has to agree,
    // otherwise the record of what retention did under-reports it forever.
    const verifier = new DatabaseSync(databasePath);
    try {
      const row = verifier.prepare(
        `SELECT annotations_deleted, verification_notes_cleared FROM deletion_runs`,
      ).get() as { annotations_deleted: number; verification_notes_cleared: number };
      assert.equal(row.verification_notes_cleared, 1);
      assert.equal(row.annotations_deleted, 0);
      const note = verifier.prepare(`SELECT note FROM verification_records WHERE id = ?`)
        .get("verification_audit") as { note: string | null };
      assert.equal(note.note, null);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
