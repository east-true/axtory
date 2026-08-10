import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { applyRetention } from "../../src/core/deletion.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "../../src/core/policy.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

test("retention expires classified user annotations and leaves other classifications alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-annotation-retention-"));
  try {
    const walking = await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "output.json"),
      now: () => new Date("2026-08-01T00:00:00.000Z"), randomId: () => "annotation-retention-fixture",
    });
    const database = new AxtoryDatabase(walking.databasePath);
    try {
      database.insertUserAnnotation({
        id: "annotation-expired", targetType: "SOURCE_REVISION", targetId: walking.output.sourceRevisionId,
        assertion: "old personal note", dataClassification: "PERSONAL_DATA", baselineMinutes: null,
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      database.insertUserAnnotation({
        id: "annotation-recent", targetType: "SOURCE_REVISION", targetId: walking.output.sourceRevisionId,
        assertion: "recent personal note", dataClassification: "PERSONAL_DATA", baselineMinutes: null,
        createdAt: "2026-08-08T00:00:00.000Z",
      });
      database.insertUserAnnotation({
        id: "annotation-other-class", targetType: "SOURCE_REVISION", targetId: walking.output.sourceRevisionId,
        assertion: "old note under an unexpired classification", dataClassification: "LOCAL_METADATA", baselineMinutes: null,
        createdAt: "2026-07-01T00:00:00.000Z",
      });
    } finally {
      database.close();
    }

    const result = await applyRetention({
      dataDirectory: directory,
      policy: {
        ...DEFAULT_LOCAL_COLLECTION_POLICY,
        version: "test-annotation-retention/1",
        classifications: {
          ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications,
          PERSONAL_DATA: {
            ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications.PERSONAL_DATA, retentionDays: 7,
          },
        },
      },
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => "annotation-retention",
    });
    assert.equal(result.annotationsDeleted, 1);

    const verifier = new AxtoryDatabase(walking.databasePath);
    try {
      assert.deepEqual(verifier.userAnnotations({}).map((item) => item.id),
        ["annotation-other-class", "annotation-recent"]);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("retention clears an expired verification note but keeps the verification itself", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-note-retention-"));
  try {
    const walking = await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "output.json"),
      now: () => new Date("2026-08-01T00:00:00.000Z"), randomId: () => "note-retention-fixture",
    });
    const database = new AxtoryDatabase(walking.databasePath);
    try {
      const fact = database.inventory().analysisRecords.find((item) => item.key === "session.count");
      assert.ok(fact);
      database.insertVerificationRecord({
        id: "verification-expired", analysisRecordId: fact.analysisRecordId,
        verificationType: "HUMAN_ACCEPTANCE", status: "VERIFIED", provenance: "USER_PROVIDED",
        evidenceIds: [], note: "old private note", noteClassification: "PERSONAL_DATA",
        verifiedAt: "2026-07-01T00:00:00.000Z",
      });
      database.insertVerificationRecord({
        id: "verification-recent", analysisRecordId: fact.analysisRecordId,
        verificationType: "TECHNICAL", status: "PARTIAL", provenance: "USER_PROVIDED",
        evidenceIds: [], note: "recent note", noteClassification: "PERSONAL_DATA",
        verifiedAt: "2026-08-08T00:00:00.000Z",
      });
    } finally {
      database.close();
    }

    const result = await applyRetention({
      dataDirectory: directory,
      policy: {
        ...DEFAULT_LOCAL_COLLECTION_POLICY,
        version: "test-note-retention/1",
        classifications: {
          ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications,
          PERSONAL_DATA: { ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications.PERSONAL_DATA, retentionDays: 7 },
        },
      },
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => "note-retention",
    });
    assert.equal(result.verificationNotesCleared, 1);

    const verifier = new AxtoryDatabase(walking.databasePath);
    try {
      const notes = verifier.verificationNotes({});
      // Both verifications survive; only the expired note's text is gone.
      assert.equal(notes.length, 2);
      assert.equal(notes.find((item) => item.id === "verification-expired")!.note, null);
      assert.equal(notes.find((item) => item.id === "verification-expired")!.status, "VERIFIED");
      assert.equal(notes.find((item) => item.id === "verification-recent")!.note, "recent note");
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
