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
      assert.equal(version.user_version, 2);
      assert.equal(revision.id, "existing-revision");
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
