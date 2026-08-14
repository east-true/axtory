import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentAddressedBlobStore } from "../../src/core/blob-store.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

async function seedHeaderOnlyRevision(directory: string, options: {
  revisionId: string;
  sourceObjectId: string;
  completedCollection?: boolean;
}): Promise<string> {
  const blob = await new ContentAddressedBlobStore(join(directory, "blobs"))
    .put(new TextEncoder().encode(`raw-${options.revisionId}`));
  const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
  try {
    database.upsertSourceObject(options.sourceObjectId, "CLAUDE_CODE", options.sourceObjectId);
    database.insertRevision({
      id: options.revisionId, sourceObjectId: options.sourceObjectId, contentHash: blob.digest,
      collectedAt: "2026-08-14T00:00:00.000Z", sourceModifiedAt: "2026-08-14T00:00:00.000Z",
      normalizerVersion: "claude-official-history/3", payloadReference: blob.relativePath,
    });
    if (options.completedCollection) {
      database.startCollectionRun("collection_completed", "CLAUDE_CODE", "2026-08-14T00:00:00.000Z");
      database.linkCollectionRevision(
        "collection_completed", options.sourceObjectId, options.revisionId, "2026-08-14T00:00:00.000Z",
      );
      database.finishCollectionRun("collection_completed", "COMPLETED", "2026-08-14T00:01:00.000Z");
    }
  } finally {
    database.close();
  }
  return blob.relativePath;
}

test("an interrupted header-only revision is removed so the next collection can rebuild it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-incomplete-revision-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    const reference = await seedHeaderOnlyRevision(directory, {
      revisionId: "revision_interrupted", sourceObjectId: "source_interrupted",
    });

    await ensureAxtoryDataDirectory(directory);

    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.equal(database.count("source_revisions"), 0);
      assert.equal(database.count("source_objects"), 0);
    } finally {
      database.close();
    }
    await assert.rejects(access(join(directory, "blobs", reference)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed revision identity is preserved even when its raw and derived rows are absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-completed-empty-revision-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    const reference = await seedHeaderOnlyRevision(directory, {
      revisionId: "revision_completed", sourceObjectId: "source_completed", completedCollection: true,
    });

    await ensureAxtoryDataDirectory(directory);

    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.equal(database.count("source_revisions"), 1);
      assert.equal(database.count("source_objects"), 1);
    } finally {
      database.close();
    }
    await access(join(directory, "blobs", reference));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
