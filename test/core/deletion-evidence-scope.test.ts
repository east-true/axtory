import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ContentAddressedBlobStore } from "../../src/core/blob-store.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";
import { executeSelectiveDeletion } from "../../src/core/deletion.js";
import type { AnalysisRecord, NormalizedObservation, RawObservation } from "../../src/core/records.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

function observation(id: string, sourceRevisionId: string): NormalizedObservation {
  return {
    id,
    sourceRevisionId,
    stableKey: `message:${id}`,
    kind: "CONTENT",
    derivation: "OBSERVED",
    provenance: "LOCAL_FILE",
    dataClassification: "CONVERSATION_CONTENT",
    occurredAt: null,
    timeQuality: "UNKNOWN",
    payload: {},
  } as NormalizedObservation;
}

function analysisRecord(id: string, key: string, evidenceIds: readonly string[]): AnalysisRecord {
  return {
    id,
    analysisRunId: "analysis-run",
    key,
    recordType: "METRIC",
    derivation: "CALCULATED",
    value: 1,
    unit: "count",
    availability: "AVAILABLE",
    reason: null,
    evidenceIds,
    evidenceStatus: "PRESENT",
  };
}

test("raw deletion marks only records backed by the deleted revision", async () => {
  const parent = await mkdtemp(join(tmpdir(), "axtory-deletion-evidence-status-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(parent, "data"));
    const blobs = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
    const blobA = await blobs.put(Buffer.from("raw-a"));
    const blobB = await blobs.put(Buffer.from("raw-b"));
    const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
    try {
      for (const [suffix, payloadReference] of [["a", blobA.relativePath], ["b", blobB.relativePath]] as const) {
        database.upsertSourceObject(`source-${suffix}`, "FIXTURE", `external-${suffix}`);
        database.insertRevision({
          id: `revision-${suffix}`,
          sourceObjectId: `source-${suffix}`,
          contentHash: `hash-${suffix}`,
          collectedAt: "2026-08-14T00:00:00.000Z",
          sourceModifiedAt: null,
          normalizerVersion: "test/1",
          payloadReference,
        });
        database.insertRawObservation({
          id: `raw-${suffix}`,
          sourceRevisionId: `revision-${suffix}`,
          observationType: "FIXTURE_DOCUMENT",
          provenance: "LOCAL_FILE",
          dataClassification: "CONVERSATION_CONTENT",
          payloadReference,
          observedAt: "2026-08-14T00:00:00.000Z",
          sourceModifiedAt: null,
        } satisfies RawObservation);
        database.insertObservations([observation(`observation-${suffix}`, `revision-${suffix}`)]);
      }
      database.startAnalysisRun({
        id: "analysis-run",
        analyzerType: "test",
        analyzerVersion: "1",
        inputRevisionIds: ["revision-a", "revision-b"],
        startedAt: "2026-08-14T00:00:00.000Z",
      });
      database.insertAnalysisRecords([
        analysisRecord("record-a", "only-a", ["observation-a"]),
        analysisRecord("record-b", "only-b", ["observation-b"]),
        analysisRecord("record-both", "both", ["observation-a", "observation-b"]),
        analysisRecord("record-none", "none", []),
      ]);
      database.finishAnalysisRun("analysis-run", "COMPLETED", "2026-08-14T00:00:01.000Z");
    } finally {
      database.close();
    }

    const deletion = await executeSelectiveDeletion({
      dataDirectory,
      mode: "DELETE_RAW_ONLY",
      target: { revisionIds: ["revision-a"] },
      confirmation: "DELETE_RAW_ONLY",
      now: () => new Date("2026-08-14T00:01:00.000Z"),
      randomId: () => "evidence-status",
    });
    assert.equal(deletion.rawObservationsDeleted, 1);

    const verifier = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
    try {
      const analysis = verifier.completedAnalysisForExactInputs(
        "test",
        "1",
        ["revision-a", "revision-b"],
      );
      assert.ok(analysis);
      assert.deepEqual(Object.fromEntries(analysis.records.map((record) => [record.key, record.evidenceStatus])), {
        both: "EVIDENCE_REMOVED",
        none: "PRESENT",
        "only-a": "EVIDENCE_REMOVED",
        "only-b": "PRESENT",
      });
    } finally {
      verifier.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
