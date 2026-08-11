import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { ContentAddressedBlobStore } from "../../src/core/blob-store.js";
import { canonicalJson, stableId } from "../../src/core/canonical-json.js";
import { renormalizeStoredRevisions } from "../../src/core/renormalize.js";
import type { AnalysisRecord, NormalizedObservation } from "../../src/core/records.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

const THREAD = {
  id: "thread-1", sessionId: "session-1", forkedFromId: null, parentThreadId: null, preview: "",
  ephemeral: false, modelProvider: "openai", createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
  recencyAt: null, status: { type: "idle" }, path: null, cwd: "/home/someone/project",
  cliVersion: "0.147.0", source: "cli", threadSource: null, agentNickname: null, agentRole: null,
  gitInfo: { sha: "abc", branch: "main", originUrl: null }, name: null,
  turns: [{
    id: "turn-1", itemsView: "full", status: "completed", startedAt: 1_700_000_001,
    completedAt: 1_700_000_002, durationMs: 1_000,
    items: [{ type: "userMessage", id: "user-1", content: [{ type: "text", text: "hello" }] }],
  }],
};

/**
 * A directory holding one Codex revision normalized by an older normalizer, so its session
 * observation predates the workspace field the current normalizer records.
 */
async function seeded(options: { withRawEvidence?: boolean; withAnalysis?: boolean } = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axtory-renormalize-"));
  const blobs = new ContentAddressedBlobStore(join(directory, "blobs"));
  const raw = new TextEncoder().encode(canonicalJson({ thread: THREAD }));
  const blob = await blobs.put(raw);
  const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
  try {
    const sourceObjectId = "source_thread";
    const revisionId = "revision_thread";
    database.startCollectionRun("collection_1", "CODEX", "2026-03-01T00:00:00.000Z");
    database.upsertSourceObject(sourceObjectId, "CODEX", "thread-1");
    database.insertRevision({
      id: revisionId, sourceObjectId, contentHash: blob.digest,
      collectedAt: "2026-03-01T00:00:00.000Z", sourceModifiedAt: "2026-03-01T00:00:00.000Z",
      normalizerVersion: "codex-app-server/1", payloadReference: blob.relativePath,
    });
    if (options.withRawEvidence !== false) {
      database.insertRawObservation({
        id: stableId("raw", { revisionId }), sourceRevisionId: revisionId,
        observationType: "CODEX_THREAD_VIEW", provenance: "OFFICIAL_API",
        dataClassification: "CONVERSATION_CONTENT", payloadReference: blob.relativePath,
        observedAt: "2026-03-01T00:00:00.000Z", sourceModifiedAt: "2026-03-01T00:00:00.000Z",
      });
    }
    // The older normalization: a session observation carrying coverage but no workspace.
    const observations: NormalizedObservation[] = [{
      id: stableId("obs", { revisionId, stableKey: "session" }),
      sourceRevisionId: revisionId, stableKey: "session", kind: "SNAPSHOT",
      derivation: "OBSERVED", provenance: "OFFICIAL_API", dataClassification: "LOCAL_METADATA",
      occurredAt: "2026-03-01T00:00:00.000Z", timeQuality: "SOURCE_REPORTED",
      payload: { messageCoverage: "PARTIAL_COMPACTION", sourceConversationIdentity: "digest" },
    }];
    database.insertObservations(observations);
    database.linkCollectionRevision("collection_1", sourceObjectId, revisionId, "2026-03-01T00:00:00.000Z");
    database.finishCollectionRun("collection_1", "COMPLETED", "2026-03-01T00:00:00.000Z");
    if (options.withAnalysis) {
      database.startAnalysisRun({
        id: "analysis_1", analyzerType: "FACT_ANALYZER", analyzerVersion: "test/1",
        inputRevisionIds: [revisionId], startedAt: "2026-03-02T00:00:00.000Z",
      });
      database.insertAnalysisRecords([{
        id: "record_1", analysisRunId: "analysis_1", key: "session.count", recordType: "METRIC",
        derivation: "CALCULATED", value: 1, unit: "count", availability: "AVAILABLE",
        reason: null, evidenceIds: [observations[0]!.id], evidenceStatus: "PRESENT",
      } satisfies AnalysisRecord]);
      database.finishAnalysisRun("analysis_1", "COMPLETED", "2026-03-02T00:00:00.000Z");
    }
  } finally {
    database.close();
  }
  return directory;
}

function sessionPayload(directory: string): Record<string, unknown> {
  const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
  try {
    const observation = database.observationsForRevision("revision_thread")
      .find((item) => item.stableKey === "session");
    assert.ok(observation, "a session observation is expected");
    return observation.payload;
  } finally {
    database.close();
  }
}

test("re-normalization backfills a field the stored normalization predates", async () => {
  const directory = await seeded();
  try {
    assert.equal("workspaceIdentity" in sessionPayload(directory), false);
    const summary = await renormalizeStoredRevisions({ dataDirectory: directory });
    assert.equal(summary.revisionsRenormalized, 1);
    assert.equal(summary.revisionsAlreadyCurrent, 0);

    const payload = sessionPayload(directory);
    assert.equal(typeof payload.workspaceIdentity, "string");
    assert.equal(typeof payload.branchIdentity, "string");
    // Coverage describes the read that happened, not the content, so it is carried forward rather
    // than recomputed into a completeness claim.
    assert.equal(payload.messageCoverage, "PARTIAL_COMPACTION");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("re-normalization records the version and is idempotent", async () => {
  const directory = await seeded();
  try {
    await renormalizeStoredRevisions({ dataDirectory: directory });
    const second = await renormalizeStoredRevisions({ dataDirectory: directory });
    assert.equal(second.revisionsRenormalized, 0, "a second pass must not redo settled work");
    assert.equal(second.revisionsAlreadyCurrent, 1);
    assert.equal(second.analysisRecordsInvalidated, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a dry run reports what would change without touching the database", async () => {
  const directory = await seeded();
  try {
    const summary = await renormalizeStoredRevisions({ dataDirectory: directory, dryRun: true });
    assert.equal(summary.revisionsRenormalized, 1);
    assert.equal("workspaceIdentity" in sessionPayload(directory), false, "a dry run must not write");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("analysis records built on a re-normalized revision become INVALIDATED", async () => {
  const directory = await seeded({ withAnalysis: true });
  try {
    const summary = await renormalizeStoredRevisions({ dataDirectory: directory });
    assert.equal(summary.analysisRecordsInvalidated, 1);
    const sqlite = new DatabaseSync(join(directory, "axtory.sqlite3"), { readOnly: true });
    try {
      const row = sqlite.prepare(`SELECT evidence_status FROM analysis_records WHERE id = 'record_1'`)
        .get() as { evidence_status: string };
      // Not EVIDENCE_REMOVED: the evidence is present, it was recomputed.
      assert.equal(row.evidence_status, "INVALIDATED");
    } finally {
      sqlite.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw evidence is never modified by re-normalization", async () => {
  const directory = await seeded();
  try {
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    const reference = database.rawObservationForRevision("revision_thread")!.payloadReference;
    database.close();
    const before = await readFile(join(directory, "blobs", reference));
    await renormalizeStoredRevisions({ dataDirectory: directory });
    const after = await readFile(join(directory, "blobs", reference));
    assert.deepEqual(after, before, "recomputing a derived layer must not rewrite the original");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a revision whose raw evidence was deleted keeps its observations", async () => {
  const directory = await seeded({ withRawEvidence: false });
  try {
    const summary = await renormalizeStoredRevisions({ dataDirectory: directory });
    assert.equal(summary.rawEvidenceUnavailable, 1);
    assert.equal(summary.revisionsRenormalized, 0);
    // The old normalization is all that survives of this revision, so it is kept rather than lost.
    assert.equal(sessionPayload(directory).messageCoverage, "PARTIAL_COMPACTION");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
