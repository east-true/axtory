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
      assert.equal(version.user_version, 9);
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
      assert.equal((verifier.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema v3 gains completed-collection revision observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-migration-v3-"));
  const path = join(directory, "axtory.sqlite3");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE collection_runs (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE source_objects (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE source_revisions (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 3;
    `);
    legacy.close();
    const migrated = new AxtoryDatabase(path);
    assert.equal(migrated.count("collection_revision_observations"), 0);
    migrated.close();
    const verifier = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((verifier.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema v4 snapshots legacy heads before requiring completed collection observations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-migration-v4-"));
  const path = join(directory, "axtory.sqlite3");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE source_objects (id TEXT PRIMARY KEY, source_type TEXT NOT NULL) STRICT;
      INSERT INTO source_objects VALUES ('source-1', 'CODEX');
      CREATE TABLE source_revisions (
        id TEXT PRIMARY KEY,
        source_object_id TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        source_modified_at TEXT
      ) STRICT;
      INSERT INTO source_revisions VALUES ('revision-old', 'source-1', '2026-01-01T00:00:00Z', NULL);
      INSERT INTO source_revisions VALUES ('revision-new', 'source-1', '2026-02-01T00:00:00Z', NULL);
      CREATE TABLE collection_runs (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE collection_revision_observations (
        collection_run_id TEXT NOT NULL,
        source_object_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(collection_run_id, source_object_id)
      ) STRICT;
      PRAGMA user_version = 4;
    `);
    legacy.close();
    const migrated = new AxtoryDatabase(path);
    assert.equal(migrated.count("legacy_revision_heads"), 1);
    migrated.close();
    const verifier = new DatabaseSync(path, { readOnly: true });
    try {
      const head = verifier.prepare("SELECT source_revision_id FROM legacy_revision_heads").get() as
        { source_revision_id: string };
      assert.equal(head.source_revision_id, "revision-new");
      assert.equal((verifier.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema v5 classifies existing user annotations without discarding their text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-migration-v5-"));
  const path = join(directory, "axtory.sqlite3");
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE user_annotations (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        assertion TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO user_annotations
        VALUES ('annotation-legacy', 'SOURCE_REVISION', 'revision-1', 'kept text', '2026-01-01T00:00:00Z');
      CREATE TABLE deletion_runs (id TEXT PRIMARY KEY) STRICT;
      PRAGMA user_version = 5;
    `);
    legacy.close();
    const migrated = new AxtoryDatabase(path);
    migrated.close();
    const verifier = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((verifier.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 9);
      const row = verifier.prepare(`SELECT assertion, data_classification FROM user_annotations`).get() as
        { assertion: string; data_classification: string };
      assert.equal(row.assertion, "kept text");
      assert.equal(row.data_classification, "PERSONAL_DATA");
      const columns = verifier.prepare("PRAGMA table_info(deletion_runs)").all() as Array<{ name: string }>;
      assert.ok(columns.some((item) => item.name === "annotations_deleted"));
      // Schema 7 adds the baseline column and leaves it null for a claim nobody made.
      const annotationColumns = verifier.prepare("PRAGMA table_info(user_annotations)").all() as
        Array<{ name: string }>;
      assert.ok(annotationColumns.some((item) => item.name === "baseline_minutes"));
      assert.equal((verifier.prepare(
        `SELECT baseline_minutes FROM user_annotations`,
      ).get() as { baseline_minutes: number | null }).baseline_minutes, null);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
