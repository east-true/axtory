import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import type { AnalysisRecord, NormalizedObservation, RawObservation } from "./records.js";

export interface RevisionInput {
  id: string;
  sourceObjectId: string;
  contentHash: string;
  collectedAt: string;
  sourceModifiedAt: string | null;
  normalizerVersion: string;
  payloadReference: string;
}

export interface AnalysisRunInput {
  id: string;
  analyzerType: string;
  analyzerVersion: string;
  inputRevisionIds: readonly string[];
  startedAt: string;
}

export class AxtoryDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 2) throw new Error(`database schema ${version.user_version} is newer than supported`);
    if (version.user_version === 2) return;
    if (version.user_version === 1) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE raw_observations (
          id TEXT PRIMARY KEY,
          source_revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
          observation_type TEXT NOT NULL,
          provenance TEXT NOT NULL,
          data_classification TEXT NOT NULL,
          payload_reference TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          source_modified_at TEXT,
          UNIQUE(source_revision_id, observation_type)
        ) STRICT;
        PRAGMA user_version = 2;
        COMMIT;
      `);
      return;
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE collection_runs (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','FAILED')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_code TEXT
      ) STRICT;
      CREATE TABLE source_objects (
        id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL,
        external_key TEXT NOT NULL,
        UNIQUE(source_type, external_key)
      ) STRICT;
      CREATE TABLE source_revisions (
        id TEXT PRIMARY KEY,
        source_object_id TEXT NOT NULL REFERENCES source_objects(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        source_modified_at TEXT,
        normalizer_version TEXT NOT NULL,
        payload_reference TEXT NOT NULL,
        UNIQUE(source_object_id, content_hash)
      ) STRICT;
      CREATE TABLE normalized_observations (
        id TEXT PRIMARY KEY,
        source_revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
        stable_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        derivation TEXT NOT NULL CHECK(derivation = 'OBSERVED'),
        provenance TEXT NOT NULL,
        data_classification TEXT NOT NULL,
        occurred_at TEXT,
        time_quality TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(source_revision_id, stable_key)
      ) STRICT;
      CREATE TABLE raw_observations (
        id TEXT PRIMARY KEY,
        source_revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
        observation_type TEXT NOT NULL,
        provenance TEXT NOT NULL,
        data_classification TEXT NOT NULL,
        payload_reference TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        source_modified_at TEXT,
        UNIQUE(source_revision_id, observation_type)
      ) STRICT;
      CREATE TABLE analysis_runs (
        id TEXT PRIMARY KEY,
        analyzer_type TEXT NOT NULL,
        analyzer_version TEXT NOT NULL,
        input_revision_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('STARTED','COMPLETED','FAILED')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error_code TEXT
      ) STRICT;
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
      CREATE TABLE export_runs (
        id TEXT PRIMARY KEY,
        sink TEXT NOT NULL,
        destination TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        classifications_json TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        exported_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }

  transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  startCollectionRun(id: string, sourceType: string, startedAt: string): void {
    this.db.prepare(`INSERT INTO collection_runs(id, source_type, status, started_at)
      VALUES (?, ?, 'STARTED', ?)`).run(id, sourceType, startedAt);
  }

  reconcileInterruptedRuns(reconciledAt: string): { collections: number; analyses: number } {
    const collections = this.db.prepare(`UPDATE collection_runs
      SET status = 'FAILED', completed_at = ?, error_code = 'INTERRUPTED'
      WHERE status = 'STARTED'`).run(reconciledAt).changes;
    const analyses = this.db.prepare(`UPDATE analysis_runs
      SET status = 'FAILED', completed_at = ?, error_code = 'INTERRUPTED'
      WHERE status = 'STARTED'`).run(reconciledAt).changes;
    return { collections: Number(collections), analyses: Number(analyses) };
  }

  finishCollectionRun(id: string, status: "COMPLETED" | "FAILED", completedAt: string, errorCode?: string): void {
    this.db.prepare(`UPDATE collection_runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?`)
      .run(status, completedAt, errorCode ?? null, id);
  }

  upsertSourceObject(id: string, sourceType: string, externalKey: string): void {
    this.db.prepare(`INSERT INTO source_objects(id, source_type, external_key) VALUES (?, ?, ?)
      ON CONFLICT(source_type, external_key) DO NOTHING`).run(id, sourceType, externalKey);
  }

  insertRevision(input: RevisionInput): boolean {
    const result = this.db.prepare(`INSERT INTO source_revisions(
      id, source_object_id, content_hash, collected_at, source_modified_at, normalizer_version, payload_reference
    ) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_object_id, content_hash) DO NOTHING`).run(
      input.id, input.sourceObjectId, input.contentHash, input.collectedAt, input.sourceModifiedAt,
      input.normalizerVersion, input.payloadReference,
    );
    return result.changes === 1;
  }

  findRevisionBySourceModifiedAt(sourceObjectId: string, sourceModifiedAt: string): string | null {
    const row = this.db.prepare(`SELECT id FROM source_revisions
      WHERE source_object_id = ? AND source_modified_at = ?
      ORDER BY collected_at DESC LIMIT 1`).get(sourceObjectId, sourceModifiedAt) as
      { id: string } | undefined;
    return row?.id ?? null;
  }

  insertObservations(observations: readonly NormalizedObservation[]): void {
    const statement = this.db.prepare(`INSERT INTO normalized_observations(
      id, source_revision_id, stable_key, kind, derivation, provenance, data_classification,
      occurred_at, time_quality, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_revision_id, stable_key) DO NOTHING`);
    for (const item of observations) {
      statement.run(item.id, item.sourceRevisionId, item.stableKey, item.kind, item.derivation,
        item.provenance, item.dataClassification, item.occurredAt, item.timeQuality,
        canonicalJson(item.payload));
    }
  }

  insertRawObservation(observation: RawObservation): void {
    this.db.prepare(`INSERT INTO raw_observations(
      id, source_revision_id, observation_type, provenance, data_classification,
      payload_reference, observed_at, source_modified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_revision_id, observation_type) DO NOTHING`).run(
      observation.id, observation.sourceRevisionId, observation.observationType,
      observation.provenance, observation.dataClassification, observation.payloadReference,
      observation.observedAt, observation.sourceModifiedAt,
    );
  }

  observationsForRevision(revisionId: string): NormalizedObservation[] {
    const rows = this.db.prepare(`SELECT id, source_revision_id, stable_key, kind, derivation,
      provenance, data_classification, occurred_at, time_quality, payload_json
      FROM normalized_observations WHERE source_revision_id = ? ORDER BY stable_key`).all(revisionId) as
      Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!,
      sourceRevisionId: row.source_revision_id!,
      stableKey: row.stable_key!,
      kind: row.kind as NormalizedObservation["kind"],
      derivation: "OBSERVED",
      provenance: row.provenance as NormalizedObservation["provenance"],
      dataClassification: row.data_classification as NormalizedObservation["dataClassification"],
      occurredAt: row.occurred_at ?? null,
      timeQuality: row.time_quality as NormalizedObservation["timeQuality"],
      payload: JSON.parse(row.payload_json!) as Record<string, unknown>,
    }));
  }

  startAnalysisRun(input: AnalysisRunInput): void {
    this.db.prepare(`INSERT INTO analysis_runs(
      id, analyzer_type, analyzer_version, input_revision_ids_json, status, started_at
    ) VALUES (?, ?, ?, ?, 'STARTED', ?)`).run(
      input.id, input.analyzerType, input.analyzerVersion,
      canonicalJson(input.inputRevisionIds), input.startedAt,
    );
  }

  finishAnalysisRun(id: string, status: "COMPLETED" | "FAILED", completedAt: string, errorCode?: string): void {
    this.db.prepare(`UPDATE analysis_runs SET status = ?, completed_at = ?, error_code = ? WHERE id = ?`)
      .run(status, completedAt, errorCode ?? null, id);
  }

  insertAnalysisRecords(records: readonly AnalysisRecord[]): void {
    const statement = this.db.prepare(`INSERT INTO analysis_records(
      id, analysis_run_id, key, record_type, derivation, value_json, unit,
      availability, reason, evidence_ids_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of records) {
      statement.run(item.id, item.analysisRunId, item.key, item.recordType, item.derivation,
        canonicalJson(item.value), item.unit, item.availability, item.reason,
        canonicalJson(item.evidenceIds));
    }
  }

  recordExport(input: {
    id: string; sink: string; destination: string; policyVersion: string; recordCount: number;
    classifications: readonly string[]; status: string; payloadDigest: string; exportedAt: string;
  }): void {
    this.db.prepare(`INSERT INTO export_runs(
      id, sink, destination, policy_version, record_count, classifications_json,
      status, payload_digest, exported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.sink, input.destination, input.policyVersion, input.recordCount,
      canonicalJson(input.classifications), input.status, input.payloadDigest, input.exportedAt,
    );
  }

  count(table: "collection_runs" | "source_revisions" | "raw_observations" | "normalized_observations" | "analysis_runs" | "export_runs"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}
