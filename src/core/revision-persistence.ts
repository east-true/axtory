import type { NormalizedObservation, RawObservation } from "./records.js";
import type { RevisionInput } from "./storage.js";
import { AxtoryDatabase } from "./storage.js";

/**
 * Persist one collected source state as a single SQLite unit.
 *
 * A SourceRevision is not a usable collected state by itself. Its source identity, raw reference,
 * normalized observations, and collection-run link must either all commit or all roll back. Keeping
 * this boundary in one helper prevents collectors from accidentally publishing a revision header
 * before the evidence that makes it readable exists.
 */
export function persistCollectedRevision(database: AxtoryDatabase, input: {
  collectionRunId: string;
  sourceObject: { id: string; sourceType: string; externalKey: string };
  revision: RevisionInput;
  rawObservation: RawObservation;
  observations: readonly NormalizedObservation[];
  observedAt: string;
}): { created: boolean } {
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
}
