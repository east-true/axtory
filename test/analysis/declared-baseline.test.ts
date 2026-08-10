import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { generateUsageReport, renderUsageReport } from "../../src/analysis/usage-report.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

async function seeded(): Promise<{ directory: string; revisionId: string; databasePath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "axtory-declared-baseline-"));
  const walking = await runWalkingSkeleton({
    fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
    jsonOutputPath: join(directory, "fixture.json"),
    now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => "baseline-fixture",
  });
  return { directory, revisionId: walking.output.sourceRevisionId, databasePath: walking.databasePath };
}

test("an exportable declared baseline is reported as the user's assertion, never as measured savings", async () => {
  const { directory, revisionId, databasePath } = await seeded();
  try {
    const database = new AxtoryDatabase(databasePath);
    try {
      database.insertUserAnnotation({
        id: "baseline-a", targetType: "SOURCE_REVISION", targetId: revisionId,
        assertion: "manual baseline", dataClassification: "LOCAL_METADATA", baselineMinutes: 240,
        createdAt: "2026-08-09T00:01:00.000Z",
      });
      database.insertUserAnnotation({
        id: "baseline-b", targetType: "SOURCE_REVISION", targetId: revisionId,
        assertion: "another manual baseline", dataClassification: "LOCAL_METADATA", baselineMinutes: 60,
        createdAt: "2026-08-09T00:02:00.000Z",
      });
      // An annotation without a baseline must not be counted as a zero-minute claim.
      database.insertUserAnnotation({
        id: "no-baseline", targetType: "SOURCE_REVISION", targetId: revisionId,
        assertion: "just a note", dataClassification: "LOCAL_METADATA", baselineMinutes: null,
        createdAt: "2026-08-09T00:03:00.000Z",
      });
    } finally {
      database.close();
    }

    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      now: () => new Date("2026-08-10T00:00:00.000Z"), randomId: () => `baseline-${++sequence}`,
    });
    const baseline = report.annotations.declaredBaseline;
    assert.equal(baseline.availability, "AVAILABLE");
    assert.equal(baseline.records, 2);
    assert.equal(baseline.totalMinutes, 300);
    assert.equal(baseline.withheldRecords, 0);
    assert.match(baseline.reason!, /does not measure elapsed working time/u);
    assert.ok(report.limitations.some((item) => /not a measurement/u.test(item)));
    assert.match(renderUsageReport(report), /Declared baseline: AVAILABLE, 300 minutes across 2 records/u);

    const written = await readFile(join(directory, "usage.json"), "utf8");
    assert.equal(written.includes("manual baseline"), false, "annotation text must stay out of the export");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a baseline whose classification forbids export is withheld rather than counted", async () => {
  const { directory, revisionId, databasePath } = await seeded();
  try {
    const database = new AxtoryDatabase(databasePath);
    try {
      database.insertUserAnnotation({
        id: "baseline-personal", targetType: "SOURCE_REVISION", targetId: revisionId,
        assertion: "private baseline", dataClassification: "PERSONAL_DATA", baselineMinutes: 120,
        createdAt: "2026-08-09T00:01:00.000Z",
      });
    } finally {
      database.close();
    }

    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      now: () => new Date("2026-08-10T00:00:00.000Z"), randomId: () => `withheld-${++sequence}`,
    });
    const baseline = report.annotations.declaredBaseline;
    assert.equal(baseline.availability, "REDACTED");
    assert.equal(baseline.records, null);
    assert.equal(baseline.totalMinutes, null, "a withheld baseline must not collapse to zero");
    assert.equal(baseline.withheldRecords, 1);
    assert.match(baseline.reason!, /does not allow export/u);
    assert.equal((await readFile(join(directory, "usage.json"), "utf8")).includes("120"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a scope with no declared baseline stays NOT_COLLECTED instead of reporting zero minutes", async () => {
  const { directory } = await seeded();
  try {
    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      now: () => new Date("2026-08-10T00:00:00.000Z"), randomId: () => `absent-${++sequence}`,
    });
    assert.equal(report.annotations.declaredBaseline.availability, "NOT_COLLECTED");
    assert.equal(report.annotations.declaredBaseline.totalMinutes, null);
    assert.equal(report.annotations.declaredBaseline.withheldRecords, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a declared baseline must be a non-negative integer number of minutes", async () => {
  const { directory, revisionId, databasePath } = await seeded();
  try {
    const database = new AxtoryDatabase(databasePath);
    try {
      for (const invalid of [-30, 12.5]) {
        assert.throws(() => database.insertUserAnnotation({
          id: `invalid-${invalid}`, targetType: "SOURCE_REVISION", targetId: revisionId,
          assertion: "bad baseline", dataClassification: "LOCAL_METADATA", baselineMinutes: invalid,
          createdAt: "2026-08-09T00:01:00.000Z",
        }), /non-negative integer number of minutes/u);
      }
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
