import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

test("user-authored annotations and verification notes remain readable after they are recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-annotation-readback-"));
  try {
    const walking = await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "output.json"),
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => "readback-fixture",
    });
    const database = new AxtoryDatabase(walking.databasePath);
    try {
      const fact = database.inventory().analysisRecords.find((item) => item.key === "session.count");
      assert.ok(fact);
      database.insertUserAnnotation({
        id: "annotation-revision", targetType: "SOURCE_REVISION", targetId: walking.output.sourceRevisionId,
        assertion: "manual baseline: about four hours without an agent",
        dataClassification: "PERSONAL_DATA", baselineMinutes: 240,
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      database.insertUserAnnotation({
        id: "annotation-record", targetType: "ANALYSIS_RECORD", targetId: fact.analysisRecordId,
        assertion: "this count excludes the session I abandoned", dataClassification: "LOCAL_METADATA", baselineMinutes: null,
        createdAt: "2026-08-09T00:02:00.000Z",
      });
      database.insertVerificationRecord({
        id: "verification-readback", analysisRecordId: fact.analysisRecordId,
        verificationType: "HUMAN_ACCEPTANCE", status: "VERIFIED", provenance: "USER_PROVIDED",
        evidenceIds: [], note: "checked against the deploy log", noteClassification: "PERSONAL_DATA", verifiedAt: "2026-08-09T00:03:00.000Z",
      });

      const all = database.userAnnotations({});
      assert.equal(all.length, 2);
      assert.deepEqual(all.map((item) => item.assertion), [
        "manual baseline: about four hours without an agent",
        "this count excludes the session I abandoned",
      ]);

      const byType = database.userAnnotations({ targetType: "ANALYSIS_RECORD" });
      assert.equal(byType.length, 1);
      assert.equal(byType[0]!.id, "annotation-record");

      const byTarget = database.userAnnotations({ targetId: walking.output.sourceRevisionId });
      assert.equal(byTarget.length, 1);
      assert.equal(byTarget[0]!.id, "annotation-revision");

      const notes = database.verificationNotes({});
      assert.equal(notes.length, 1);
      assert.equal(notes[0]!.note, "checked against the deploy log");
      assert.equal(notes[0]!.status, "VERIFIED");
      assert.deepEqual(database.verificationNotes({ analysisRecordId: "missing" }), []);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
