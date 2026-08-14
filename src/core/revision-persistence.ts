import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { withDataMutationLock } from "./mutation-lock.js";
import type { NormalizedObservation, RawObservation } from "./records.js";
import type { RevisionInput } from "./storage.js";
import { AxtoryDatabase } from "./storage.js";

async function verifyPayloadPresent(dataDirectory: string, payloadReference: string): Promise<void> {
  const blobRoot = resolve(dataDirectory, "blobs");
  const target = resolve(blobRoot, payloadReference);
  const nested = relative(blobRoot, target);
  if (nested === "" || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error("collected revision payload reference escapes the blob store");
  }
  const metadata = await lstat(target);
  if (!metadata.isFile()) throw new Error("collected revision payload is not a regular blob file");
}

/**
 * Persist one collected source state as a single SQLite unit under the data-directory mutation lease.
 *
 * Blob creation can happen before this call, but the payload is re-checked after the lease is held.
 * Therefore a concurrent deletion can never commit between payload existence and the DB reference:
 * either the blob survived and the whole revision bundle commits, or persistence fails without a DB
 * reference to a missing file.
 */
export async function persistCollectedRevision(database: AxtoryDatabase, input: {
  dataDirectory: string;
  collectionRunId: string;
  sourceObject: { id: string; sourceType: string; externalKey: string };
  revision: RevisionInput;
  rawObservation: RawObservation;
  observations: readonly NormalizedObservation[];
  observedAt: string;
}): Promise<{ created: boolean }> {
  return withDataMutationLock(input.dataDirectory, async () => {
    await verifyPayloadPresent(input.dataDirectory, input.revision.payloadReference);
    return database.transaction(() => {
      database.upsertSourceObject(
        input.sourceObject.id,
        input.sourceObject.sourceType,
        input.sourceObject.externalKey,
      );
      const created = database.insertRevision(input.revision);
      database.insertRawObservation(input.rawObservation);
      database.insertObservations(input.observations);
      database.linkCollectionRevision(
        input.collectionRunId,
        input.sourceObject.id,
        input.revision.id,
        input.observedAt,
      );
      return { created };
    });
  });
}
