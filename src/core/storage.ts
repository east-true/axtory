import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import type {
  AnalysisRecord,
  DataClassification,
  NormalizedObservation,
  RawObservation,
  UserAnnotation,
  VerificationRecord,
  VerificationStatus,
  VerificationType,
} from "./records.js";
import type { CollectionPolicy } from "./policy.js";

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
    if (version.user_version > 9) throw new Error(`database schema ${version.user_version} is newer than supported`);
    if (version.user_version === 9) return;
    if (version.user_version === 8) {
      this.migrateToVersion9();
      return;
    }
    if (version.user_version === 7) {
      this.migrateToVersion8();
      this.migrateToVersion9();
      return;
    }
    if (version.user_version === 6) {
      this.migrateToVersion7();
      this.migrateToVersion8();
      this.migrateToVersion9();
      return;
    }
    if (version.user_version === 5) {
      this.migrateToVersion6();
      this.migrateToVersion7();
      this.migrateToVersion8();
      this.migrateToVersion9();
      return;
    }
    if (version.user_version === 4) {
      this.migrateToVersion5();
      this.migrateToVersion6();
      this.migrateToVersion7();
      this.migrateToVersion8();
      this.migrateToVersion9();
      return;
    }
    if (version.user_version === 3) {
      this.migrateToVersion4();
      this.migrateToVersion5();
      this.migrateToVersion6();
      this.migrateToVersion7();
      this.migrateToVersion8();
      this.migrateToVersion9();
      return;
    }
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
    } else if (version.user_version === 0) this.db.exec(`
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
    const analysisRecordsTable = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analysis_records'`,
    ).get();
    this.db.exec(`
      BEGIN IMMEDIATE;
      ${analysisRecordsTable ? `ALTER TABLE analysis_records ADD COLUMN evidence_status TEXT NOT NULL DEFAULT 'PRESENT'
        CHECK(evidence_status IN ('PRESENT','EVIDENCE_REMOVED','INVALIDATED'));` : ""}
      CREATE TABLE verification_records (
        id TEXT PRIMARY KEY,
        analysis_record_id TEXT NOT NULL REFERENCES analysis_records(id) ON DELETE CASCADE,
        verification_type TEXT NOT NULL,
        status TEXT NOT NULL,
        provenance TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        note TEXT,
        verified_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE user_annotations (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK(target_type IN ('SOURCE_REVISION','ANALYSIS_RECORD')),
        target_id TEXT NOT NULL,
        assertion TEXT NOT NULL CHECK(length(trim(assertion)) > 0),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE collection_policies (
        version TEXT PRIMARY KEY,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE deletion_runs (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL,
        target_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('COMPLETED','FAILED')),
        raw_observations_deleted INTEGER NOT NULL,
        normalized_observations_deleted INTEGER NOT NULL,
        analysis_runs_deleted INTEGER NOT NULL,
        blobs_deleted INTEGER NOT NULL,
        spool_entries_deleted INTEGER NOT NULL,
        executed_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = 3;
      COMMIT;
    `);
    this.migrateToVersion4();
    this.migrateToVersion5();
    this.migrateToVersion6();
    this.migrateToVersion7();
    this.migrateToVersion8();
    this.migrateToVersion9();
  }

  private migrateToVersion4(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE collection_revision_observations (
        collection_run_id TEXT NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
        source_object_id TEXT NOT NULL REFERENCES source_objects(id) ON DELETE CASCADE,
        source_revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(collection_run_id, source_object_id)
      ) STRICT;
      CREATE INDEX collection_revision_observations_source_idx
        ON collection_revision_observations(source_object_id, observed_at DESC);
      PRAGMA user_version = 4;
      COMMIT;
    `);
  }

  private migrateToVersion5(): void {
    const sourceObjectColumns = this.db.prepare("PRAGMA table_info(source_objects)").all() as
      Array<{ name: string }>;
    const revisionColumns = this.db.prepare("PRAGMA table_info(source_revisions)").all() as
      Array<{ name: string }>;
    const canBackfill = sourceObjectColumns.some((item) => item.name === "id") &&
      revisionColumns.some((item) => item.name === "source_object_id") &&
      revisionColumns.some((item) => item.name === "collected_at");
    this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS legacy_revision_heads (
        source_object_id TEXT PRIMARY KEY REFERENCES source_objects(id) ON DELETE CASCADE,
        source_revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE
      ) STRICT;
      ${canBackfill ? `INSERT OR IGNORE INTO legacy_revision_heads(source_object_id, source_revision_id)
        SELECT source_object_id, revision_id FROM (
          SELECT source_object_id, id AS revision_id,
            ROW_NUMBER() OVER (
              PARTITION BY source_object_id ORDER BY collected_at DESC, rowid DESC
            ) AS revision_rank
          FROM source_revisions
        ) WHERE revision_rank = 1;` : ""}
      PRAGMA user_version = 5;
      COMMIT;
    `);
  }

  // Schema 6 gives user-authored annotation text a DataClassification so retention can expire it,
  // and records how many annotations a retention run removed. Existing rows predate any explicit
  // choice, so they take the most restrictive default rather than a permissive one.
  // A partially constructed legacy database may lack a table entirely, so an ALTER is only safe when
  // the table exists and the column is not already present.
  private needsColumn(table: string, column: string): boolean {
    const present = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    ).get(table);
    if (!present) return false;
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return !columns.some((item) => item.name === column);
  }

  private migrateToVersion6(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      ${this.needsColumn("user_annotations", "data_classification")
        ? `ALTER TABLE user_annotations
            ADD COLUMN data_classification TEXT NOT NULL DEFAULT 'PERSONAL_DATA';` : ""}
      ${this.needsColumn("deletion_runs", "annotations_deleted")
        ? `ALTER TABLE deletion_runs ADD COLUMN annotations_deleted INTEGER NOT NULL DEFAULT 0;` : ""}
      PRAGMA user_version = 6;
      COMMIT;
    `);
  }

  // Schema 7 lets an annotation carry a declared baseline in minutes. It stays NULL for every
  // annotation that makes no such claim, because AXtory must not invent a duration nobody stated.
  private migrateToVersion7(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      ${this.needsColumn("user_annotations", "baseline_minutes")
        ? `ALTER TABLE user_annotations ADD COLUMN baseline_minutes INTEGER;` : ""}
      PRAGMA user_version = 7;
      COMMIT;
    `);
  }

  // Schema 8 classifies the note a verification carries. The note is optional text on a record whose
  // status is not text, so retention clears the note and keeps the verification itself.
  private migrateToVersion8(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      ${this.needsColumn("verification_records", "note_classification")
        ? `ALTER TABLE verification_records
            ADD COLUMN note_classification TEXT NOT NULL DEFAULT 'PERSONAL_DATA';` : ""}
      PRAGMA user_version = 8;
      COMMIT;
    `);
  }

  // Schema 9 records cleared verification notes in the deletion audit. Retention already cleared
  // them and reported the count to the caller, but the durable row under-reported what ran.
  private migrateToVersion9(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      ${this.needsColumn("deletion_runs", "verification_notes_cleared")
        ? `ALTER TABLE deletion_runs ADD COLUMN verification_notes_cleared INTEGER NOT NULL DEFAULT 0;` : ""}
      PRAGMA user_version = 9;
      COMMIT;
    `);
  }

  /**
   * SQLite rejects a statement carrying more than 32766 host parameters, so an `IN (?, ?, …)` list
   * built from caller-supplied ids fails outright once a database holds enough evidence. Splitting
   * the list keeps those lookups working at any size. A row can match more than one batch, so every
   * caller that could see the same row twice deduplicates by row id rather than summing batches.
   */
  private static readonly MAXIMUM_QUERY_PARAMETERS = 20_000;

  private batches(values: readonly string[]): string[][] {
    const size = AxtoryDatabase.MAXIMUM_QUERY_PARAMETERS;
    if (values.length <= size) return [[...values]];
    const output: string[][] = [];
    for (let start = 0; start < values.length; start += size) {
      output.push(values.slice(start, start + size));
    }
    return output;
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

  prepareSecureDeletion(): void {
    this.db.exec("PRAGMA secure_delete = ON;");
  }

  finalizeSecureDeletion(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
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

  linkCollectionRevision(
    collectionRunId: string,
    sourceObjectId: string,
    sourceRevisionId: string,
    observedAt: string,
  ): void {
    this.db.prepare(`INSERT INTO collection_revision_observations(
      collection_run_id, source_object_id, source_revision_id, observed_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(collection_run_id, source_object_id) DO UPDATE SET
      source_revision_id = excluded.source_revision_id,
      observed_at = excluded.observed_at`).run(
      collectionRunId, sourceObjectId, sourceRevisionId, observedAt,
    );
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

  latestRevisions(): Array<{
    sourceObjectId: string;
    sourceType: string;
    revisionId: string;
    collectedAt: string;
    sourceModifiedAt: string | null;
    headSelection: "COMPLETED_COLLECTION" | "LEGACY_REVISION_ORDER";
  }> {
    const rows = this.db.prepare(`WITH linked_ranked AS (
      SELECT so.id AS source_object_id, so.source_type, sr.id AS revision_id,
        sr.collected_at, sr.source_modified_at,
        ROW_NUMBER() OVER (
          PARTITION BY so.id
          ORDER BY cr.completed_at DESC, cro.observed_at DESC, cro.rowid DESC
        ) AS revision_rank
      FROM collection_revision_observations cro
      JOIN collection_runs cr ON cr.id = cro.collection_run_id AND cr.status = 'COMPLETED'
      JOIN source_objects so ON so.id = cro.source_object_id
      JOIN source_revisions sr ON sr.id = cro.source_revision_id
    )
    SELECT source_object_id, source_type, revision_id, collected_at, source_modified_at,
      'COMPLETED_COLLECTION' AS head_selection
    FROM linked_ranked WHERE revision_rank = 1
    UNION ALL
    SELECT so.id AS source_object_id, so.source_type, sr.id AS revision_id,
      sr.collected_at, sr.source_modified_at,
      'LEGACY_REVISION_ORDER' AS head_selection
    FROM legacy_revision_heads legacy
    JOIN source_objects so ON so.id = legacy.source_object_id
    JOIN source_revisions sr ON sr.id = legacy.source_revision_id
    WHERE so.id NOT IN (SELECT source_object_id FROM linked_ranked)
    ORDER BY source_type, source_object_id`).all() as Array<Record<string, string | null>>;
    return rows.map((row) => ({
      sourceObjectId: row.source_object_id!,
      sourceType: row.source_type!,
      revisionId: row.revision_id!,
      collectedAt: row.collected_at!,
      sourceModifiedAt: row.source_modified_at ?? null,
      headSelection: row.head_selection as "COMPLETED_COLLECTION" | "LEGACY_REVISION_ORDER",
    }));
  }

  completedAnalysisForExactInputs(
    analyzerType: string,
    analyzerVersion: string,
    inputRevisionIds: readonly string[],
  ): { analysisRunId: string; records: AnalysisRecord[] } | null {
    const run = this.db.prepare(`SELECT id FROM analysis_runs
      WHERE analyzer_type = ? AND analyzer_version = ? AND input_revision_ids_json = ?
        AND status = 'COMPLETED'
      ORDER BY completed_at DESC, rowid DESC LIMIT 1`).get(
      analyzerType, analyzerVersion, canonicalJson(inputRevisionIds),
    ) as { id: string } | undefined;
    if (!run) return null;
    const rows = this.db.prepare(`SELECT id, analysis_run_id, key, record_type, derivation,
      value_json, unit, availability, reason, evidence_ids_json, evidence_status
      FROM analysis_records WHERE analysis_run_id = ? ORDER BY key, id`).all(run.id) as
      Array<Record<string, string | null>>;
    return {
      analysisRunId: run.id,
      records: rows.map((row) => ({
        id: row.id!, analysisRunId: row.analysis_run_id!, key: row.key!,
        recordType: row.record_type as AnalysisRecord["recordType"],
        derivation: row.derivation as AnalysisRecord["derivation"],
        value: JSON.parse(row.value_json!), unit: row.unit ?? null,
        availability: row.availability as AnalysisRecord["availability"],
        reason: row.reason ?? null,
        evidenceIds: JSON.parse(row.evidence_ids_json!) as string[],
        evidenceStatus: row.evidence_status as AnalysisRecord["evidenceStatus"],
      })),
    };
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
      availability, reason, evidence_ids_json, evidence_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of records) {
      statement.run(item.id, item.analysisRunId, item.key, item.recordType, item.derivation,
        canonicalJson(item.value), item.unit, item.availability, item.reason,
        canonicalJson(item.evidenceIds), item.evidenceStatus);
    }
  }

  insertVerificationRecord(record: VerificationRecord): void {
    this.db.prepare(`INSERT INTO verification_records(
      id, analysis_record_id, verification_type, status, provenance,
      evidence_ids_json, note, note_classification, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.analysisRecordId, record.verificationType, record.status,
      record.provenance, canonicalJson(record.evidenceIds), record.note, record.noteClassification,
      record.verifiedAt,
    );
  }

  // Retention clears the text and keeps the verification, because a status is not the note that
  // explains it and deleting the record would destroy an unexpired fact.
  verificationNotesEligibleForRetention(classification: string, verifiedBefore: string): string[] {
    return (this.db.prepare(`SELECT id FROM verification_records
      WHERE note IS NOT NULL AND note_classification = ? AND verified_at < ? ORDER BY id`)
      .all(classification, verifiedBefore) as Array<{ id: string }>).map((row) => row.id);
  }

  clearVerificationNotes(verificationIds: readonly string[]): number {
    if (verificationIds.length === 0) return 0;
    let cleared = 0;
    for (const batch of this.batches(verificationIds)) {
      const placeholders = batch.map(() => "?").join(",");
      cleared += Number(this.db.prepare(
        `UPDATE verification_records SET note = NULL WHERE note IS NOT NULL AND id IN (${placeholders})`,
      ).run(...batch).changes);
    }
    return cleared;
  }

  verificationRecordsForEvidenceIds(evidenceIds: readonly string[]): Array<{
    verificationType: VerificationType;
    status: VerificationStatus;
    analysisEvidenceStatus: AnalysisRecord["evidenceStatus"];
  }> {
    if (evidenceIds.length === 0) return [];
    const matched = new Map<string, { verification_type: string; status: string; evidence_status: string }>();
    for (const batch of this.batches(evidenceIds)) {
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT vr.id, vr.verification_type, vr.status, ar.evidence_status
        FROM verification_records vr
        JOIN analysis_records ar ON ar.id = vr.analysis_record_id
        JOIN analysis_runs run ON run.id = ar.analysis_run_id AND run.status = 'COMPLETED'
        WHERE EXISTS (SELECT 1 FROM json_each(ar.evidence_ids_json) WHERE value IN (${placeholders}))
        ORDER BY vr.verified_at, vr.id`).all(...batch) as Array<{
          id: string; verification_type: string; status: string; evidence_status: string;
        }>;
      for (const row of rows) matched.set(row.id, row);
    }
    return [...matched.values()].map((row) => ({
      verificationType: row.verification_type as VerificationType,
      status: row.status as VerificationStatus,
      analysisEvidenceStatus: row.evidence_status as AnalysisRecord["evidenceStatus"],
    }));
  }

  annotationCountsForScope(revisionIds: readonly string[], evidenceIds: readonly string[]): {
    sourceRevision: number;
    analysisRecord: number;
  } {
    let sourceRevision = 0;
    for (const batch of this.batches(revisionIds)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      // An annotation targets exactly one revision, so batches stay disjoint here.
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM user_annotations
        WHERE target_type = 'SOURCE_REVISION' AND target_id IN (${placeholders})`)
        .get(...batch) as { count: number };
      sourceRevision += row.count;
    }
    if (evidenceIds.length === 0) return { sourceRevision, analysisRecord: 0 };
    const annotationIds = new Set<string>();
    for (const batch of this.batches(evidenceIds)) {
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT ua.id
        FROM user_annotations ua
        JOIN analysis_records ar ON ar.id = ua.target_id AND ua.target_type = 'ANALYSIS_RECORD'
        JOIN analysis_runs run ON run.id = ar.analysis_run_id AND run.status = 'COMPLETED'
        WHERE EXISTS (SELECT 1 FROM json_each(ar.evidence_ids_json) WHERE value IN (${placeholders}))`)
        .all(...batch) as Array<{ id: string }>;
      for (const row of rows) annotationIds.add(row.id);
    }
    return { sourceRevision, analysisRecord: annotationIds.size };
  }

  insertUserAnnotation(annotation: UserAnnotation): void {
    if (annotation.assertion.trim().length === 0) throw new Error("a user annotation requires an assertion");
    const targetTable = annotation.targetType === "SOURCE_REVISION" ? "source_revisions" : "analysis_records";
    const target = this.db.prepare(`SELECT id FROM ${targetTable} WHERE id = ?`).get(annotation.targetId);
    if (!target) throw new Error("user annotation target does not exist");
    // The CLI already rejects zero, and a baseline of no time is not a claim anyone makes, so both
    // boundaries agree on a positive integer rather than disagreeing about zero.
    if (annotation.baselineMinutes !== null &&
      (!Number.isInteger(annotation.baselineMinutes) || annotation.baselineMinutes <= 0)) {
      throw new Error("a declared baseline must be a positive integer number of minutes");
    }
    this.db.prepare(`INSERT INTO user_annotations(
      id, target_type, target_id, assertion, data_classification, baseline_minutes, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      annotation.id, annotation.targetType, annotation.targetId, annotation.assertion,
      annotation.dataClassification, annotation.baselineMinutes, annotation.createdAt,
    );
  }

  annotationsEligibleForRetention(classification: string, createdBefore: string): string[] {
    return (this.db.prepare(`SELECT id FROM user_annotations
      WHERE data_classification = ? AND created_at < ? ORDER BY id`)
      .all(classification, createdBefore) as Array<{ id: string }>).map((row) => row.id);
  }

  deleteAnnotations(annotationIds: readonly string[]): number {
    if (annotationIds.length === 0) return 0;
    let deleted = 0;
    for (const batch of this.batches(annotationIds)) {
      const placeholders = batch.map(() => "?").join(",");
      deleted += Number(this.db.prepare(`DELETE FROM user_annotations WHERE id IN (${placeholders})`)
        .run(...batch).changes);
    }
    return deleted;
  }

  // User-authored text has no read path other than this one: the usage report deliberately exports
  // counts only, so an annotation or verification note would otherwise be write-only.
  userAnnotations(filter: { targetType?: UserAnnotation["targetType"]; targetId?: string }): UserAnnotation[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filter.targetType !== undefined) {
      conditions.push("target_type = ?");
      parameters.push(filter.targetType);
    }
    if (filter.targetId !== undefined) {
      conditions.push("target_id = ?");
      parameters.push(filter.targetId);
    }
    const rows = this.db.prepare(`SELECT id, target_type, target_id, assertion, data_classification,
      baseline_minutes, created_at
      FROM user_annotations ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
      ORDER BY created_at, id`).all(...parameters) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: row.id as string, targetType: row.target_type as UserAnnotation["targetType"],
      targetId: row.target_id as string, assertion: row.assertion as string,
      dataClassification: row.data_classification as DataClassification,
      baselineMinutes: row.baseline_minutes === null ? null : Number(row.baseline_minutes),
      createdAt: row.created_at as string,
    }));
  }

  // Baselines are returned with their classification so the analysis layer can apply the export
  // policy; storage does not decide what may leave the machine.
  declaredBaselinesForScope(revisionIds: readonly string[], evidenceIds: readonly string[]): Array<{
    baselineMinutes: number; dataClassification: DataClassification;
  }> {
    // A baseline is a total, so each annotation must contribute exactly once even when its record
    // is reached through several evidence ids spread over different batches.
    const rows = new Map<string, Record<string, string | number>>();
    for (const batch of this.batches(revisionIds)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db.prepare(`SELECT id, baseline_minutes, data_classification FROM user_annotations
        WHERE target_type = 'SOURCE_REVISION' AND baseline_minutes IS NOT NULL
          AND target_id IN (${placeholders})`).all(...batch) as Array<Record<string, string | number>>) {
        rows.set(String(row.id), row);
      }
    }
    for (const batch of this.batches(evidenceIds)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      for (const row of this.db.prepare(`SELECT ua.id, ua.baseline_minutes, ua.data_classification
        FROM user_annotations ua
        JOIN analysis_records ar ON ar.id = ua.target_id AND ua.target_type = 'ANALYSIS_RECORD'
        JOIN analysis_runs run ON run.id = ar.analysis_run_id AND run.status = 'COMPLETED'
        WHERE ua.baseline_minutes IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(ar.evidence_ids_json) WHERE value IN (${placeholders}))`)
        .all(...batch) as Array<Record<string, string | number>>) {
        rows.set(String(row.id), row);
      }
    }
    return [...rows.values()].map((row) => ({
      baselineMinutes: Number(row.baseline_minutes),
      dataClassification: row.data_classification as DataClassification,
    }));
  }

  verificationNotes(filter: { analysisRecordId?: string }): Array<{
    id: string; analysisRecordId: string; verificationType: VerificationType;
    status: VerificationStatus; note: string | null; verifiedAt: string;
  }> {
    const rows = this.db.prepare(`SELECT id, analysis_record_id, verification_type, status, note, verified_at
      FROM verification_records ${filter.analysisRecordId === undefined ? "" : "WHERE analysis_record_id = ?"}
      ORDER BY verified_at, id`)
      .all(...(filter.analysisRecordId === undefined ? [] : [filter.analysisRecordId])) as
      Array<Record<string, string | null>>;
    return rows.map((row) => ({
      id: row.id!, analysisRecordId: row.analysis_record_id!,
      verificationType: row.verification_type as VerificationType,
      status: row.status as VerificationStatus, note: row.note ?? null, verifiedAt: row.verified_at!,
    }));
  }

  saveCollectionPolicy(policy: CollectionPolicy, createdAt: string): void {
    this.db.prepare(`INSERT INTO collection_policies(version, policy_json, created_at)
      VALUES (?, ?, ?) ON CONFLICT(version) DO UPDATE SET policy_json = excluded.policy_json`).run(
      policy.version, canonicalJson(policy), createdAt,
    );
  }

  loadCollectionPolicy(version: string): CollectionPolicy | null {
    const row = this.db.prepare(`SELECT policy_json FROM collection_policies WHERE version = ?`)
      .get(version) as { policy_json: string } | undefined;
    return row ? JSON.parse(row.policy_json) as CollectionPolicy : null;
  }

  rawObservationsEligibleForRetention(classification: string, observedBefore: string): Array<{
    id: string; sourceRevisionId: string; payloadReference: string;
  }> {
    return this.db.prepare(`SELECT id, source_revision_id, payload_reference
      FROM raw_observations WHERE data_classification = ? AND observed_at < ? ORDER BY id`)
      .all(classification, observedBefore).map((row) => {
        const item = row as Record<string, string>;
        return { id: item.id!, sourceRevisionId: item.source_revision_id!, payloadReference: item.payload_reference! };
      });
  }

  rawObservationsForRevisionIds(revisionIds: readonly string[]): Array<{
    id: string; sourceRevisionId: string; payloadReference: string;
  }> {
    if (revisionIds.length === 0) return [];
    return this.batches(revisionIds).flatMap((batch) => {
      const placeholders = batch.map(() => "?").join(",");
      return this.db.prepare(`SELECT id, source_revision_id, payload_reference FROM raw_observations
        WHERE source_revision_id IN (${placeholders})`).all(...batch).map((row) => {
          const item = row as Record<string, string>;
          return {
            id: item.id!, sourceRevisionId: item.source_revision_id!, payloadReference: item.payload_reference!,
          };
        });
    }).sort((left, right) => left.id.localeCompare(right.id));
  }

  rawObservationForRevision(revisionId: string): {
    id: string; payloadReference: string; dataClassification: string; observationType: RawObservation["observationType"];
  } | null {
    const row = this.db.prepare(`SELECT id, payload_reference, data_classification, observation_type
      FROM raw_observations WHERE source_revision_id = ? ORDER BY id LIMIT 1`).get(revisionId) as
      Record<string, string> | undefined;
    return row ? {
      id: row.id!, payloadReference: row.payload_reference!, dataClassification: row.data_classification!,
      observationType: row.observation_type as RawObservation["observationType"],
    } : null;
  }

  revisionIdsForSourceObject(sourceObjectId: string): string[] {
    return this.db.prepare(`SELECT id FROM source_revisions WHERE source_object_id = ? ORDER BY id`)
      .all(sourceObjectId).map((row) => (row as { id: string }).id);
  }

  deleteRawObservations(rawObservationIds: readonly string[]): number {
    if (rawObservationIds.length === 0) return 0;
    let deleted = 0;
    for (const batch of this.batches(rawObservationIds)) {
      const placeholders = batch.map(() => "?").join(",");
      deleted += Number(this.db.prepare(`DELETE FROM raw_observations WHERE id IN (${placeholders})`)
        .run(...batch).changes);
    }
    return deleted;
  }

  markEvidenceRemoved(evidenceIds: readonly string[]): number {
    if (evidenceIds.length === 0) return 0;
    const evidence = new Set(evidenceIds);
    const rows = this.db.prepare(`SELECT id, evidence_ids_json FROM analysis_records
      WHERE evidence_status = 'PRESENT'`).all() as Array<{ id: string; evidence_ids_json: string }>;
    let changed = 0;
    const statement = this.db.prepare(`UPDATE analysis_records SET evidence_status = 'EVIDENCE_REMOVED'
      WHERE id = ?`);
    for (const row of rows) {
      const ids = JSON.parse(row.evidence_ids_json) as string[];
      if (ids.some((id) => evidence.has(id))) changed += Number(statement.run(row.id).changes);
    }
    return changed;
  }

  private analysisRunIdsForInputRevisions(revisionIds: readonly string[]): string[] {
    const runIds = new Set<string>();
    for (const batch of this.batches(revisionIds)) {
      if (batch.length === 0) continue;
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db.prepare(`SELECT id FROM analysis_runs
        WHERE EXISTS (SELECT 1 FROM json_each(analysis_runs.input_revision_ids_json)
          WHERE value IN (${placeholders}))`).all(...batch) as Array<{ id: string }>;
      for (const row of rows) runIds.add(row.id);
    }
    return [...runIds];
  }

  markEvidenceRemovedForRevisionIds(revisionIds: readonly string[]): number {
    if (revisionIds.length === 0) return 0;
    const runIds = this.analysisRunIdsForInputRevisions(revisionIds);
    if (runIds.length === 0) return 0;
    let changed = 0;
    for (const batch of this.batches(runIds)) {
      const runPlaceholders = batch.map(() => "?").join(",");
      changed += Number(this.db.prepare(`UPDATE analysis_records SET evidence_status = 'EVIDENCE_REMOVED'
        WHERE evidence_status = 'PRESENT' AND evidence_ids_json != '[]'
          AND analysis_run_id IN (${runPlaceholders})`).run(...batch).changes);
    }
    return changed;
  }

  deleteDerivedForRevisionIds(revisionIds: readonly string[]): {
    normalizedObservations: number; analysisRuns: number;
  } {
    if (revisionIds.length === 0) return { normalizedObservations: 0, analysisRuns: 0 };
    const runIds = this.analysisRunIdsForInputRevisions(revisionIds);
    let normalizedObservations = 0;
    for (const batch of this.batches(revisionIds)) {
      const placeholders = batch.map(() => "?").join(",");
      normalizedObservations += Number(this.db.prepare(
        `DELETE FROM normalized_observations WHERE source_revision_id IN (${placeholders})`,
      ).run(...batch).changes);
    }
    let analysisRuns = 0;
    const deleteRun = this.db.prepare(`DELETE FROM analysis_runs WHERE id = ?`);
    for (const runId of runIds) {
      this.db.prepare(`DELETE FROM user_annotations WHERE target_type = 'ANALYSIS_RECORD'
        AND target_id IN (SELECT id FROM analysis_records WHERE analysis_run_id = ?)`).run(runId);
      analysisRuns += Number(deleteRun.run(runId).changes);
    }
    return { normalizedObservations, analysisRuns };
  }

  deleteSourceObject(sourceObjectId: string): number {
    this.db.prepare(`DELETE FROM user_annotations WHERE target_type = 'SOURCE_REVISION'
      AND target_id IN (SELECT id FROM source_revisions WHERE source_object_id = ?)`).run(sourceObjectId);
    return Number(this.db.prepare(`DELETE FROM source_objects WHERE id = ?`).run(sourceObjectId).changes);
  }

  externalKeyForSourceObject(sourceObjectId: string): string | null {
    const row = this.db.prepare(`SELECT external_key FROM source_objects WHERE id = ?`).get(sourceObjectId) as
      { external_key: string } | undefined;
    return row?.external_key ?? null;
  }

  rawReferenceCount(payloadReference: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM raw_observations WHERE payload_reference = ?`)
      .get(payloadReference) as { count: number };
    return row.count;
  }

  recordDeletion(input: {
    id: string; mode: string; target: unknown; status: "COMPLETED" | "FAILED";
    rawObservationsDeleted: number; normalizedObservationsDeleted: number;
    analysisRunsDeleted: number; blobsDeleted: number; spoolEntriesDeleted: number;
    annotationsDeleted: number; verificationNotesCleared: number; executedAt: string;
  }): void {
    this.db.prepare(`INSERT INTO deletion_runs(
      id, mode, target_json, status, raw_observations_deleted,
      normalized_observations_deleted, analysis_runs_deleted, blobs_deleted, spool_entries_deleted,
      annotations_deleted, verification_notes_cleared, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.mode, canonicalJson(input.target), input.status, input.rawObservationsDeleted,
      input.normalizedObservationsDeleted, input.analysisRunsDeleted, input.blobsDeleted,
      input.spoolEntriesDeleted, input.annotationsDeleted, input.verificationNotesCleared, input.executedAt,
    );
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

  inventory(): {
    sources: Array<{
      sourceObjectId: string; sourceType: string;
      revisions: Array<{ revisionId: string; rawRetained: boolean; collectedAt: string }>;
    }>;
    analysisRecords: Array<{
      analysisRecordId: string; key: string; recordType: string; derivation: string;
      availability: string; evidenceStatus: string;
    }>;
  } {
    const sourceRows = this.db.prepare(`SELECT so.id AS source_object_id, so.source_type,
      sr.id AS revision_id, sr.collected_at,
      EXISTS(SELECT 1 FROM raw_observations ro WHERE ro.source_revision_id = sr.id) AS raw_retained
      FROM source_objects so LEFT JOIN source_revisions sr ON sr.source_object_id = so.id
      ORDER BY so.source_type, so.id, sr.collected_at`).all() as Array<Record<string, string | number | null>>;
    const sources = new Map<string, {
      sourceObjectId: string; sourceType: string;
      revisions: Array<{ revisionId: string; rawRetained: boolean; collectedAt: string }>;
    }>();
    for (const row of sourceRows) {
      const sourceObjectId = String(row.source_object_id);
      const source = sources.get(sourceObjectId) ?? {
        sourceObjectId, sourceType: String(row.source_type), revisions: [],
      };
      if (row.revision_id !== null) source.revisions.push({
        revisionId: String(row.revision_id), rawRetained: Number(row.raw_retained) === 1,
        collectedAt: String(row.collected_at),
      });
      sources.set(sourceObjectId, source);
    }
    const analysisRecords = this.db.prepare(`SELECT id, key, record_type, derivation, availability, evidence_status
      FROM analysis_records ORDER BY key, id`).all().map((row) => {
      const item = row as Record<string, string>;
      return {
        analysisRecordId: item.id!, key: item.key!, recordType: item.record_type!,
        derivation: item.derivation!, availability: item.availability!, evidenceStatus: item.evidence_status!,
      };
    });
    return { sources: [...sources.values()], analysisRecords };
  }

  count(table: "collection_runs" | "source_objects" | "source_revisions" | "raw_observations" |
    "normalized_observations" | "analysis_runs" | "analysis_records" | "verification_records" |
    "user_annotations" | "collection_policies" | "deletion_runs" | "export_runs" |
    "collection_revision_observations" | "legacy_revision_heads"): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}
