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
