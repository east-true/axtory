import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import type { NormalizedObservation } from "./records.js";

/**
 * Atomically replace one revision's normalized evidence and invalidate every completed analysis
 * that depended on that revision.
 *
 * These writes form one invariant: once the normalized representation changes, no analysis derived
 * from the previous representation may remain PRESENT. They therefore share one SQLite transaction
 * rather than relying on a follow-up cleanup call.
 */
export function replaceDerivedEvidenceAtomically(options: {
  databasePath: string;
  revisionId: string;
  observations: readonly NormalizedObservation[];
  normalizerVersion: string;
}): { removed: number; inserted: number; analysisRecordsInvalidated: number } {
  const database = new DatabaseSync(options.databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
  try {
    const removed = Number(database.prepare(
      "DELETE FROM normalized_observations WHERE source_revision_id = ?",
    ).run(options.revisionId).changes);
    const insert = database.prepare(`INSERT INTO normalized_observations(
      id, source_revision_id, stable_key, kind, derivation, provenance, data_classification,
      occurred_at, time_quality, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of options.observations) {
      insert.run(
        item.id, item.sourceRevisionId, item.stableKey, item.kind, item.derivation,
        item.provenance, item.dataClassification, item.occurredAt, item.timeQuality,
        canonicalJson(item.payload),
      );
    }
    const versionUpdate = database.prepare(
      "UPDATE source_revisions SET normalizer_version = ? WHERE id = ?",
    ).run(options.normalizerVersion, options.revisionId);
    if (versionUpdate.changes !== 1) throw new Error("re-normalization revision does not exist");

    const invalidated = Number(database.prepare(`UPDATE analysis_records
      SET evidence_status = 'INVALIDATED'
      WHERE evidence_status = 'PRESENT'
        AND analysis_run_id IN (
          SELECT id FROM analysis_runs
          WHERE EXISTS (
            SELECT 1 FROM json_each(analysis_runs.input_revision_ids_json) WHERE value = ?
          )
        )`).run(options.revisionId).changes);
    database.exec("COMMIT");
    return { removed, inserted: options.observations.length, analysisRecordsInvalidated: invalidated };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}
