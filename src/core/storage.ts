import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./canonical-json.js";
import type {
  AnalysisRecord,
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
    if (version.user_version > 5) throw new Error(`database schema ${version.user_version} is newer than supported`);
    if (version.user_version === 5) return;
    if (version.user_version === 4) {
      this.migrateToVersion5();
      return;
    }
    if (version.user_version === 3) {
      this.migrateToVersion4();
      this.migrateToVersion5();
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
      evidence_ids_json, note, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.analysisRecordId, record.verificationType, record.status,
      record.provenance, canonicalJson(record.evidenceIds), record.note, record.verifiedAt,
    );
  }

  verificationRecordsForEvidenceIds(evidenceIds: readonly string[]): Array<{
    verificationType: VerificationType;
    status: VerificationStatus;
    analysisEvidenceStatus: AnalysisRecord["evidenceStatus"];
  }> {
    if (evidenceIds.length === 0) return [];
    const selectedEvidence = new Set(evidenceIds);
    const rows = this.db.prepare(`SELECT vr.verification_type, vr.status,
      ar.evidence_ids_json, ar.evidence_status
      FROM verification_records vr
      JOIN analysis_records ar ON ar.id = vr.analysis_record_id
      JOIN analysis_runs run ON run.id = ar.analysis_run_id AND run.status = 'COMPLETED'
      ORDER BY vr.verified_at, vr.id`).all() as Array<{
        verification_type: string;
        status: string;
        evidence_ids_json: string;
        evidence_status: string;
      }>;
    return rows.flatMap((row) => {
      const recordEvidence = JSON.parse(row.evidence_ids_json) as string[];
      if (!recordEvidence.some((id) => selectedEvidence.has(id))) return [];
      return [{
        verificationType: row.verification_type as VerificationType,
        status: row.status as VerificationStatus,
        analysisEvidenceStatus: row.evidence_status as AnalysisRecord["evidenceStatus"],
      }];
    });
  }

  annotationCountsForScope(revisionIds: readonly string[], evidenceIds: readonly string[]): {
    sourceRevision: number;
    analysisRecord: number;
  } {
    let sourceRevision = 0;
    if (revisionIds.length > 0) {
      const placeholders = revisionIds.map(() => "?").join(",");
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM user_annotations
        WHERE target_type = 'SOURCE_REVISION' AND target_id IN (${placeholders})`)
        .get(...revisionIds) as { count: number };
      sourceRevision = row.count;
    }
    if (evidenceIds.length === 0) return { sourceRevision, analysisRecord: 0 };
    const selectedEvidence = new Set(evidenceIds);
    const rows = this.db.prepare(`SELECT ar.evidence_ids_json
      FROM user_annotations ua
      JOIN analysis_records ar ON ar.id = ua.target_id AND ua.target_type = 'ANALYSIS_RECORD'
      JOIN analysis_runs run ON run.id = ar.analysis_run_id AND run.status = 'COMPLETED'`)
      .all() as Array<{ evidence_ids_json: string }>;
    const analysisRecord = rows.filter((row) =>
      (JSON.parse(row.evidence_ids_json) as string[]).some((id) => selectedEvidence.has(id))).length;
    return { sourceRevision, analysisRecord };
  }

  insertUserAnnotation(annotation: UserAnnotation): void {
    if (annotation.assertion.trim().length === 0) throw new Error("a user annotation requires an assertion");
    const targetTable = annotation.targetType === "SOURCE_REVISION" ? "source_revisions" : "analysis_records";
    const target = this.db.prepare(`SELECT id FROM ${targetTable} WHERE id = ?`).get(annotation.targetId);
    if (!target) throw new Error("user annotation target does not exist");
    this.db.prepare(`INSERT INTO user_annotations(id, target_type, target_id, assertion, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      annotation.id, annotation.targetType, annotation.targetId, annotation.assertion, annotation.createdAt,
    );
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
    const placeholders = revisionIds.map(() => "?").join(",");
    return this.db.prepare(`SELECT id, source_revision_id, payload_reference FROM raw_observations
      WHERE source_revision_id IN (${placeholders}) ORDER BY id`).all(...revisionIds).map((row) => {
        const item = row as Record<string, string>;
        return { id: item.id!, sourceRevisionId: item.source_revision_id!, payloadReference: item.payload_reference! };
      });
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
    const placeholders = rawObservationIds.map(() => "?").join(",");
    return Number(this.db.prepare(`DELETE FROM raw_observations WHERE id IN (${placeholders})`)
      .run(...rawObservationIds).changes);
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

  markEvidenceRemovedForRevisionIds(revisionIds: readonly string[]): number {
    if (revisionIds.length === 0) return 0;
    const revisions = new Set(revisionIds);
    const runIds = (this.db.prepare(`SELECT id, input_revision_ids_json FROM analysis_runs`).all() as
      Array<{ id: string; input_revision_ids_json: string }>).filter((row) =>
        (JSON.parse(row.input_revision_ids_json) as string[]).some((id) => revisions.has(id)))
      .map((row) => row.id);
    if (runIds.length === 0) return 0;
    const placeholders = runIds.map(() => "?").join(",");
    return Number(this.db.prepare(`UPDATE analysis_records SET evidence_status = 'EVIDENCE_REMOVED'
      WHERE evidence_status = 'PRESENT' AND evidence_ids_json != '[]'
        AND analysis_run_id IN (${placeholders})`).run(...runIds).changes);
  }

  deleteDerivedForRevisionIds(revisionIds: readonly string[]): {
    normalizedObservations: number; analysisRuns: number;
  } {
    if (revisionIds.length === 0) return { normalizedObservations: 0, analysisRuns: 0 };
    const revisions = new Set(revisionIds);
    const runs = (this.db.prepare(`SELECT id, input_revision_ids_json FROM analysis_runs`).all() as
      Array<{ id: string; input_revision_ids_json: string }>).filter((row) =>
        (JSON.parse(row.input_revision_ids_json) as string[]).some((id) => revisions.has(id)));
    const placeholders = revisionIds.map(() => "?").join(",");
    const normalizedObservations = Number(this.db.prepare(
      `DELETE FROM normalized_observations WHERE source_revision_id IN (${placeholders})`,
    ).run(...revisionIds).changes);
    let analysisRuns = 0;
    const deleteRun = this.db.prepare(`DELETE FROM analysis_runs WHERE id = ?`);
    for (const run of runs) {
      this.db.prepare(`DELETE FROM user_annotations WHERE target_type = 'ANALYSIS_RECORD'
        AND target_id IN (SELECT id FROM analysis_records WHERE analysis_run_id = ?)`).run(run.id);
      analysisRuns += Number(deleteRun.run(run.id).changes);
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
    analysisRunsDeleted: number; blobsDeleted: number; spoolEntriesDeleted: number; executedAt: string;
  }): void {
    this.db.prepare(`INSERT INTO deletion_runs(
      id, mode, target_json, status, raw_observations_deleted,
      normalized_observations_deleted, analysis_runs_deleted, blobs_deleted, spool_entries_deleted, executed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.id, input.mode, canonicalJson(input.target), input.status, input.rawObservationsDeleted,
      input.normalizedObservationsDeleted, input.analysisRunsDeleted, input.blobsDeleted,
      input.spoolEntriesDeleted, input.executedAt,
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
