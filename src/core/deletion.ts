import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ContentAddressedBlobStore } from "./blob-store.js";
import { ensureAxtoryDataDirectory } from "./data-directory.js";
import {
  completeStagedDeletion, rollbackStagedDeletion, stageDeletionFiles,
} from "./deletion-staging.js";
import type { DataClassification } from "./records.js";
import type { CollectionPolicy } from "./policy.js";
import { AxtoryDatabase } from "./storage.js";
import { BoundedSpool, type SpoolEnvelope } from "../live/spool.js";
import { sha256 } from "./canonical-json.js";

export type SelectiveDeletionMode =
  | "DELETE_RAW_ONLY"
  | "DELETE_RAW_AND_DERIVED"
  | "DELETE_SOURCE_SESSION";

export interface DeletionTarget {
  revisionIds?: readonly string[];
  sourceObjectId?: string;
}

export interface DeletionResult {
  mode: SelectiveDeletionMode | "RETENTION";
  rawObservationsDeleted: number;
  normalizedObservationsDeleted: number;
  analysisRunsDeleted: number;
  blobsDeleted: number;
  spoolEntriesDeleted: number;
  annotationsDeleted: number;
  verificationNotesCleared: number;
}

interface InternalDeletionOptions {
  mode: SelectiveDeletionMode | "RETENTION";
  target: DeletionTarget;
  dataDirectory: string;
  rawObservationIds?: readonly string[];
  spoolDeletePredicate?: (envelope: SpoolEnvelope) => boolean;
  annotationIds?: readonly string[];
  verificationNoteIds?: readonly string[];
  now: () => Date;
  randomId: () => string;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

async function executeInternalDeletion(
  database: AxtoryDatabase,
  blobs: ContentAddressedBlobStore,
  options: InternalDeletionOptions,
): Promise<DeletionResult> {
  const revisionIds = options.mode === "DELETE_SOURCE_SESSION"
    ? database.revisionIdsForSourceObject(options.target.sourceObjectId!)
    : unique(options.target.revisionIds ?? []);
  const raw = options.rawObservationIds
    ? (() => {
      const allowed = new Set(options.rawObservationIds);
      return database.rawObservationsForRevisionIds(revisionIds).filter((item) => allowed.has(item.id));
    })()
    : database.rawObservationsForRevisionIds(revisionIds);
  const evidenceIdsToRemove = options.mode === "DELETE_RAW_ONLY" || options.mode === "RETENTION"
    ? unique([
      ...raw.map((item) => item.id),
      ...unique(raw.map((item) => item.sourceRevisionId)).flatMap((revisionId) =>
        database.observationsForRevision(revisionId).map((item) => item.id)),
    ])
    : [];
  const sourceExternalKey = options.mode === "DELETE_SOURCE_SESSION"
    ? database.externalKeyForSourceObject(options.target.sourceObjectId!)
    : null;
  if (options.mode === "DELETE_SOURCE_SESSION" && sourceExternalKey === null) {
    throw new Error("source object does not exist");
  }

  // A content-addressed blob can be shared by several raw observations. Stage it only when every
  // database reference to that blob is part of this deletion; otherwise another retained revision
  // still owns the file.
  const targetedReferenceCounts = new Map<string, number>();
  for (const item of raw) {
    targetedReferenceCounts.set(item.payloadReference, (targetedReferenceCounts.get(item.payloadReference) ?? 0) + 1);
  }
  const blobReferences = [...targetedReferenceCounts.entries()]
    .filter(([reference, targeted]) => database.rawReferenceCount(reference) === targeted)
    .map(([reference]) => reference)
    .sort();

  const spool = new BoundedSpool(join(options.dataDirectory, "spool"));
  let spoolPaths: string[] = [];
  if (options.mode === "DELETE_SOURCE_SESSION" && sourceExternalKey) {
    const sessionIdentity = sha256(sourceExternalKey);
    const hasSession = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if (Array.isArray(value)) return value.some(hasSession);
      const item = value as Record<string, unknown>;
      if ((typeof item.session_id === "string" && sha256(item.session_id) === sessionIdentity) ||
        (item.key === "session.id" && typeof (item.value as Record<string, unknown> | undefined)?.stringValue === "string" &&
          sha256((item.value as { stringValue: string }).stringValue) === sessionIdentity)) return true;
      return Object.values(item).some(hasSession);
    };
    spoolPaths = await spool.matchingPaths((envelope) => hasSession(envelope.payload));
  } else if (options.spoolDeletePredicate) {
    spoolPaths = await spool.matchingPaths(options.spoolDeletePredicate);
  }

  const deletionId = `deletion_${options.randomId()}`;
  const executedAt = options.now().toISOString();
  const filesToStage = [
    ...blobReferences.map((reference) => blobs.deletionPath(reference)),
    ...spoolPaths,
  ];
  let staged = false;
  let committed = false;
  try {
    await stageDeletionFiles({
      dataDirectory: options.dataDirectory,
      deletionId,
      paths: filesToStage,
      createdAt: executedAt,
    });
    staged = true;

    let normalizedObservationsDeleted = 0;
    let analysisRunsDeleted = 0;
    let rawObservationsDeleted = 0;
    let annotationsDeleted = 0;
    let verificationNotesCleared = 0;
    const blobsDeleted = blobReferences.length;
    const spoolEntriesDeleted = spoolPaths.length;

    database.prepareSecureDeletion();
    database.transaction(() => {
      if (options.mode === "DELETE_RAW_ONLY" || options.mode === "RETENTION") {
        database.markEvidenceRemoved(evidenceIdsToRemove);
      } else {
        const derived = database.deleteDerivedForRevisionIds(revisionIds);
        normalizedObservationsDeleted = derived.normalizedObservations;
        analysisRunsDeleted = derived.analysisRuns;
      }
      if (options.mode === "DELETE_SOURCE_SESSION") {
        const sourceDeleted = database.deleteSourceObject(options.target.sourceObjectId!);
        if (sourceDeleted === 0) throw new Error("source object does not exist");
        rawObservationsDeleted = raw.length;
      } else {
        rawObservationsDeleted = database.deleteRawObservations(raw.map((item) => item.id));
      }
      if (options.annotationIds !== undefined) {
        annotationsDeleted = database.deleteAnnotations(options.annotationIds);
      }
      if (options.verificationNoteIds !== undefined) {
        verificationNotesCleared = database.clearVerificationNotes(options.verificationNoteIds);
      }
      database.recordDeletion({
        id: deletionId,
        mode: options.mode,
        target: options.target,
        status: "COMPLETED",
        rawObservationsDeleted,
        normalizedObservationsDeleted,
        analysisRunsDeleted,
        blobsDeleted,
        spoolEntriesDeleted,
        annotationsDeleted,
        verificationNotesCleared,
        executedAt,
      });
    });
    committed = true;

    // secure_delete applies to the transaction itself. Checkpoint/VACUUM closes the remaining SQLite
    // deletion window before staged raw files are finally discarded. If this process dies after the
    // DB commit, the durable deletion_run is the commit marker used by startup reconciliation.
    database.finalizeSecureDeletion();
    await completeStagedDeletion(options.dataDirectory, deletionId);

    return {
      mode: options.mode,
      rawObservationsDeleted,
      normalizedObservationsDeleted,
      analysisRunsDeleted,
      blobsDeleted,
      spoolEntriesDeleted,
      annotationsDeleted,
      verificationNotesCleared,
    };
  } catch (error) {
    if (staged && !committed) {
      try {
        await rollbackStagedDeletion(options.dataDirectory, deletionId);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "deletion failed and staged files could not be restored");
      }
    }
    throw error;
  }
}

export async function executeSelectiveDeletion(options: {
  dataDirectory: string;
  mode: SelectiveDeletionMode;
  target: DeletionTarget;
  confirmation: string;
  now?: () => Date;
  randomId?: () => string;
}): Promise<DeletionResult> {
  if (options.confirmation !== options.mode) {
    throw new Error(`selective deletion requires --confirm ${options.mode}`);
  }
  if (options.mode === "DELETE_SOURCE_SESSION") {
    if (!options.target.sourceObjectId || options.target.revisionIds?.length) {
      throw new Error("DELETE_SOURCE_SESSION requires exactly one source object id");
    }
  } else if (!options.target.revisionIds?.length || options.target.sourceObjectId) {
    throw new Error(`${options.mode} requires one or more revision ids`);
  }
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  try {
    return await executeInternalDeletion(database, new ContentAddressedBlobStore(join(dataDirectory, "blobs")), {
      mode: options.mode,
      target: options.target,
      dataDirectory,
      now: options.now ?? (() => new Date()),
      randomId: options.randomId ?? randomUUID,
    });
  } finally {
    database.close();
  }
}

export async function applyRetention(options: {
  dataDirectory: string;
  policy: CollectionPolicy;
  now?: () => Date;
  randomId?: () => string;
}): Promise<DeletionResult> {
  const now = options.now ?? (() => new Date());
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  try {
    const classifications = Object.entries(options.policy.classifications);
    for (const [classification, rule] of classifications) {
      if (rule.retentionDays !== null &&
        (!Number.isInteger(rule.retentionDays) || rule.retentionDays < 0)) {
        throw new Error(`invalid retention days for ${classification}`);
      }
    }
    database.saveCollectionPolicy(options.policy, now().toISOString());
    const cutoffs = new Map<DataClassification, string>();
    const eligible = classifications.flatMap(([classification, rule]) => {
      if (rule.retentionDays === null) return [];
      const cutoff = new Date(now().getTime() - rule.retentionDays * 86_400_000).toISOString();
      cutoffs.set(classification as DataClassification, cutoff);
      return database.rawObservationsEligibleForRetention(classification as DataClassification, cutoff);
    });
    const rawIds = unique(eligible.map((item) => item.id));
    const annotationIds = unique([...cutoffs].flatMap(([classification, cutoff]) =>
      database.annotationsEligibleForRetention(classification, cutoff)));
    const verificationNoteIds = unique([...cutoffs].flatMap(([classification, cutoff]) =>
      database.verificationNotesEligibleForRetention(classification, cutoff)));
    return await executeInternalDeletion(database, new ContentAddressedBlobStore(join(dataDirectory, "blobs")), {
      mode: "RETENTION",
      target: { revisionIds: unique(eligible.map((item) => item.sourceRevisionId)) },
      dataDirectory,
      rawObservationIds: rawIds,
      annotationIds,
      verificationNoteIds,
      spoolDeletePredicate: (envelope) => {
        const classification: DataClassification = envelope.channel === "CLAUDE_HOOK"
          ? "TOOL_CONTENT"
          : "PERSONAL_DATA";
        const cutoff = cutoffs.get(classification);
        return cutoff !== undefined && envelope.receivedAt < cutoff;
      },
      now,
      randomId: options.randomId ?? randomUUID,
    });
  } finally {
    database.close();
  }
}
