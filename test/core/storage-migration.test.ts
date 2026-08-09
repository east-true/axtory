import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { AxtoryDatabase } from "../../src/core/storage.js";

test("schema v1 migrates forward without discarding existing revision rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-migration-"));
  const path = join(directory, "axtory.sqlite3");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE source_revisions (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO source_revisions(id) VALUES ('existing-revision');
      PRAGMA user_version = 1;
    `);
    legacy.close();
    const migrated = new AxtoryDatabase(path);
    assert.equal(migrated.count("raw_observations"), 0);
    migrated.close();
    const verifier = new DatabaseSync(path, { readOnly: true });
    try {
      const version = verifier.prepare("PRAGMA user_version").get() as { user_version: number };
      const revision = verifier.prepare("SELECT id FROM source_revisions").get() as { id: string };
    assert.equal(version.user_version, 3);
      assert.equal(revision.id, "existing-revision");
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema v2 gains trust, policy, and deletion tables without losing analysis records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-migration-v2-"));
  const path = join(directory, "axtory.sqlite3");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE analysis_runs (id TEXT PRIMARY KEY) STRICT;
      INSERT INTO analysis_runs(id) VALUES ('run-1');
      CREATE TABLE analysis_records (
        id TEXT PRIMARY KEY,
        analysis_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        record_type TEXT NOT NULL,
        derivation TEXT NOT NULL,
        value_json TEXT NOT NULL,
        unit TEXT,
        availability TEXT NOT NULL,
        reason TEXT,
        evidence_ids_json TEXT NOT NULL,
        UNIQUE(analysis_run_id, key)
      ) STRICT;
      INSERT INTO analysis_records VALUES (
        'record-1', 'run-1', 'test', 'METRIC', 'CALCULATED', '1', 'count',
        'AVAILABLE', NULL, '[]'
      );
      PRAGMA user_version = 2;
    `);
    legacy.close();
    const migrated = new AxtoryDatabase(path);
    assert.equal(migrated.count("analysis_records"), 1);
    assert.equal(migrated.count("verification_records"), 0);
    assert.equal(migrated.count("collection_policies"), 0);
    assert.equal(migrated.count("deletion_runs"), 0);
    migrated.close();
    const verifier = new DatabaseSync(path, { readOnly: true });
    try {
      const row = verifier.prepare(`SELECT evidence_status FROM analysis_records WHERE id = 'record-1'`)
        .get() as { evidence_status: string };
      assert.equal(row.evidence_status, "PRESENT");
      assert.equal((verifier.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
