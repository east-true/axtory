import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { CODEX_NORMALIZER_VERSION } from "../../src/connectors/codex/normalizer.js";
import { ContentAddressedBlobStore } from "../../src/core/blob-store.js";
import { stableId } from "../../src/core/canonical-json.js";
import { renormalizeStoredRevisions } from "../../src/core/renormalize.js";
import type { AnalysisRecord, NormalizedObservation } from "../../src/core/records.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

const THREAD = {
  id: "thread-1", sessionId: "session-1", forkedFromId: null, parentThreadId: null, preview: "",
  ephemeral: false, modelProvider: "openai", createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
  recencyAt: null, status: { type: "idle" }, path: null, cwd: "/synthetic/project",
  cliVersion: "0.147.0", source: "cli", threadSource: null, agentNickname: null, agentRole: null,
  gitInfo: null, name: null,
  turns: [{
    id: "turn-1", itemsView: "full", status: "completed", startedAt: 1_700_000_001,
    completedAt: 1_700_000_002, durationMs: 1_000,
    items: [{ type: "userMessage", id: "message-1", content: [{ type: "text", text: "hello" }] }],
  }],
};

function oldSession(revisionId: string): NormalizedObservation {
  return {
    id: stableId("obs", { revisionId, stableKey: "session" }),
    sourceRevisionId: revisionId, stableKey: "session", kind: "SNAPSHOT",
    derivation: "OBSERVED", provenance: "OFFICIAL_API", dataClassification: "LOCAL_METADATA",
    occurredAt: "2026-03-01T00:00:00.000Z", timeQuality: "SOURCE_REPORTED",
    payload: { messageCoverage: "COMPLETE_FOR_RETURNED_VIEW", sourceConversationIdentity: "digest" },
  };
}

async function seedRevision(options: {
  directory: string;
  revisionId: string;
  sourceObjectId: string;
  rawBytes: Uint8Array;
  withAnalysis?: boolean;
}): Promise<void> {
  const blob = await new ContentAddressedBlobStore(join(options.directory, "blobs")).put(options.rawBytes);
  const database = new AxtoryDatabase(join(options.directory, "axtory.sqlite3"));
  try {
    database.upsertSourceObject(options.sourceObjectId, "CODEX", options.sourceObjectId);
    database.insertRevision({
      id: options.revisionId, sourceObjectId: options.sourceObjectId, contentHash: blob.digest,
      collectedAt: "2026-03-01T00:00:00.000Z", sourceModifiedAt: "2026-03-01T00:00:00.000Z",
      normalizerVersion: "codex-app-server/1", payloadReference: blob.relativePath,
    });
    database.insertRawObservation({
      id: stableId("raw", { revisionId: options.revisionId }), sourceRevisionId: options.revisionId,
      observationType: "CODEX_THREAD_VIEW", provenance: "OFFICIAL_API",
      dataClassification: "CONVERSATION_CONTENT", payloadReference: blob.relativePath,
      observedAt: "2026-03-01T00:00:00.000Z", sourceModifiedAt: "2026-03-01T00:00:00.000Z",
    });
    const observation = oldSession(options.revisionId);
    database.insertObservations([observation]);
    if (options.withAnalysis) {
      const analysisRunId = `analysis_${options.revisionId}`;
      database.startAnalysisRun({
        id: analysisRunId, analyzerType: "FACT_ANALYZER", analyzerVersion: "old/1",
        inputRevisionIds: [options.revisionId], startedAt: "2026-03-02T00:00:00.000Z",
      });
      database.insertAnalysisRecords([{
        id: `record_${options.revisionId}`, analysisRunId, key: "session.count", recordType: "METRIC",
        derivation: "CALCULATED", value: 1, unit: "count", availability: "AVAILABLE", reason: null,
        evidenceIds: [observation.id], evidenceStatus: "PRESENT",
      } satisfies AnalysisRecord]);
      database.finishAnalysisRun(analysisRunId, "COMPLETED", "2026-03-02T00:00:00.000Z");
    }
  } finally {
    database.close();
  }
}

test("a later renormalization failure cannot leave earlier replaced evidence marked PRESENT", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-renormalize-failure-"));
  try {
    await seedRevision({
      directory, revisionId: "revision_a", sourceObjectId: "source_a",
      rawBytes: new TextEncoder().encode(JSON.stringify({ thread: THREAD })), withAnalysis: true,
    });
    await seedRevision({
      directory, revisionId: "revision_b", sourceObjectId: "source_b",
      rawBytes: new TextEncoder().encode("{not-json"),
    });

    await assert.rejects(
      renormalizeStoredRevisions({ dataDirectory: directory }),
      /revision_b.*not valid JSON/u,
    );

    const sqlite = new DatabaseSync(join(directory, "axtory.sqlite3"), { readOnly: true });
    try {
      const first = sqlite.prepare("SELECT normalizer_version FROM source_revisions WHERE id = 'revision_a'")
        .get() as { normalizer_version: string };
      const second = sqlite.prepare("SELECT normalizer_version FROM source_revisions WHERE id = 'revision_b'")
        .get() as { normalizer_version: string };
      const analysis = sqlite.prepare("SELECT evidence_status FROM analysis_records WHERE id = 'record_revision_a'")
        .get() as { evidence_status: string };
      assert.equal(first.normalizer_version, CODEX_NORMALIZER_VERSION);
      assert.equal(second.normalizer_version, "codex-app-server/1");
      assert.equal(analysis.evidence_status, "INVALIDATED");
    } finally {
      sqlite.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
