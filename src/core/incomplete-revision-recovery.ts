import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ContentAddressedBlobStore } from "./blob-store.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table));
}

/**
 * Remove only revision headers left behind before a collection's raw/normalized transaction began.
 *
 * Collectors create the immutable revision row immediately before one transaction that inserts the
 * raw observation, normalized observations, and collection-revision link. A process failure in that
 * narrow gap leaves a revision with neither raw nor normalized evidence. Reusing it by
 * sourceModifiedAt on the next collection makes projection fail forever. A revision that belonged
 * to a completed collection (including one later stripped by DELETE_RAW_AND_DERIVED), or a legacy
 * head, is intentionally retained and is never considered an interrupted header here.
 */
export async function reconcileIncompleteRevisions(dataDirectory: string): Promise<number> {
  const databasePath = join(dataDirectory, "axtory.sqlite3");
  if (!await exists(databasePath)) return 0;

  const database = new DatabaseSync(databasePath);
  try {
    const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    // Completed-collection heads and legacy heads are both available from schema 5 onward. Older
    // databases are migrated by AxtoryDatabase before a later open can safely apply this recovery.
    if (version < 5 || !hasTable(database, "source_revisions") ||
      !hasTable(database, "normalized_observations") || !hasTable(database, "raw_observations") ||
      !hasTable(database, "collection_revision_observations") || !hasTable(database, "collection_runs") ||
      !hasTable(database, "legacy_revision_heads")) {
      return 0;
    }

    const rows = database.prepare(`SELECT sr.id, sr.payload_reference
      FROM source_revisions sr
      WHERE NOT EXISTS (
        SELECT 1 FROM raw_observations ro WHERE ro.source_revision_id = sr.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM normalized_observations no WHERE no.source_revision_id = sr.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM collection_revision_observations cro
        JOIN collection_runs cr ON cr.id = cro.collection_run_id AND cr.status = 'COMPLETED'
        WHERE cro.source_revision_id = sr.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM legacy_revision_heads legacy WHERE legacy.source_revision_id = sr.id
      )
      ORDER BY sr.id`).all() as Array<{ id: string; payload_reference: string }>;
    if (rows.length === 0) return 0;

    const orphanIds = new Set(rows.map((row) => row.id));
    const blobStore = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
    for (const reference of [...new Set(rows.map((row) => row.payload_reference))]) {
      const owners = database.prepare("SELECT id FROM source_revisions WHERE payload_reference = ?")
        .all(reference) as Array<{ id: string }>;
      if (owners.every((owner) => orphanIds.has(owner.id))) {
        // Remove the uncommitted raw file before forgetting its last durable reference. A missing
        // file is already converged; any other filesystem error aborts recovery and leaves DB rows
        // available for a retry.
        await blobStore.remove(reference);
      }
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      const removeRevision = database.prepare("DELETE FROM source_revisions WHERE id = ?");
      for (const row of rows) removeRevision.run(row.id);
      database.exec(`DELETE FROM source_objects
        WHERE NOT EXISTS (SELECT 1 FROM source_revisions sr WHERE sr.source_object_id = source_objects.id)`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return rows.length;
  } finally {
    database.close();
  }
}
