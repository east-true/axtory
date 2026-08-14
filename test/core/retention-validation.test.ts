import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyRetention } from "../../src/core/deletion.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "../../src/core/policy.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

test("invalid retention policy is rejected before it is persisted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-retention-validation-"));
  try {
    const policy = {
      ...DEFAULT_LOCAL_COLLECTION_POLICY,
      version: "invalid-retention/1",
      classifications: {
        ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications,
        CONVERSATION_CONTENT: {
          ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications.CONVERSATION_CONTENT,
          retentionDays: -1,
        },
      },
    };

    await assert.rejects(
      applyRetention({ dataDirectory: directory, policy }),
      /invalid retention days for CONVERSATION_CONTENT/u,
    );

    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.equal(database.loadCollectionPolicy("invalid-retention/1"), null);
      assert.equal(database.count("deletion_runs"), 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
