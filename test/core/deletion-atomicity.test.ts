import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";
import { stageDeletionFiles } from "../../src/core/deletion-staging.js";
import { executeSelectiveDeletion } from "../../src/core/deletion.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

async function collected(directory: string) {
  let sequence = 0;
  return runWalkingSkeleton({
    fixturePath: resolve("fixtures/synthetic/normal-session.json"),
    dataDirectory: directory,
    jsonOutputPath: join(directory, "output.json"),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    randomId: () => `atomicity-${++sequence}`,
  });
}

test("a file-staging failure leaves deletion database state untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-delete-atomicity-"));
  try {
    const run = await collected(directory);
    const sqlite = new DatabaseSync(run.databasePath, { readOnly: true });
    const raw = sqlite.prepare("SELECT payload_reference FROM raw_observations LIMIT 1").get() as
      { payload_reference: string };
    sqlite.close();

    // Simulate a storage failure that happened immediately before deletion. The deletion must fail
    // closed rather than committing database removal for a raw file it could not stage.
    await rm(join(directory, "blobs", raw.payload_reference));
    await assert.rejects(() => executeSelectiveDeletion({
      dataDirectory: directory,
      mode: "DELETE_RAW_ONLY",
      target: { revisionIds: [run.output.sourceRevisionId] },
      confirmation: "DELETE_RAW_ONLY",
      randomId: () => "staging-failure",
    }));

    const verifier = new DatabaseSync(run.databasePath, { readOnly: true });
    try {
      assert.equal((verifier.prepare("SELECT COUNT(*) AS count FROM raw_observations").get() as { count: number }).count, 1);
      assert.equal((verifier.prepare("SELECT COUNT(*) AS count FROM deletion_runs").get() as { count: number }).count, 0);
      assert.equal((verifier.prepare(
        "SELECT COUNT(*) AS count FROM analysis_records WHERE evidence_status != 'PRESENT'",
      ).get() as { count: number }).count, 0);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted uncommitted staging is restored when the data directory opens again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-stage-rollback-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    await mkdir(join(directory, "spool"), { recursive: true });
    const original = join(directory, "spool", "synthetic.json");
    await writeFile(original, "sensitive\n");
    await stageDeletionFiles({
      dataDirectory: directory,
      deletionId: "deletion_uncommitted",
      paths: [original],
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    await assert.rejects(access(original));

    const manifestPath = join(directory, ".deletion-staging", "deletion_uncommitted", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    // A PID this large is not alive in the test environment; this models restart after a crash.
    manifest.ownerPid = 2_147_483_647;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);

    await ensureAxtoryDataDirectory(directory);
    assert.equal(await readFile(original, "utf8"), "sensitive\n");
    await assert.rejects(access(join(directory, ".deletion-staging", "deletion_uncommitted")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("committed staging is finalized instead of restored after interruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-stage-commit-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    await mkdir(join(directory, "blobs"), { recursive: true });
    const original = join(directory, "blobs", "sensitive.bin");
    await writeFile(original, "sensitive");
    await stageDeletionFiles({
      dataDirectory: directory,
      deletionId: "deletion_committed",
      paths: [original],
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      database.recordDeletion({
        id: "deletion_committed", mode: "DELETE_RAW_ONLY", target: { revisionIds: ["revision"] },
        status: "COMPLETED", rawObservationsDeleted: 1, normalizedObservationsDeleted: 0,
        analysisRunsDeleted: 0, blobsDeleted: 1, spoolEntriesDeleted: 0,
        annotationsDeleted: 0, verificationNotesCleared: 0, executedAt: "2026-08-01T00:00:00.000Z",
      });
    } finally {
      database.close();
    }

    // The commit marker wins even though the staging manifest still names this live process. This
    // models a failure after DB commit but before final cleanup and allows an in-process retry too.
    await ensureAxtoryDataDirectory(directory);
    await assert.rejects(access(original));
    await assert.rejects(access(join(directory, ".deletion-staging", "deletion_committed")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
