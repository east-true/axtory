import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ContentAddressedBlobStore } from "./blob-store.js";
import { ensureAxtoryDataDirectory } from "./data-directory.js";
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
}

interface InternalDeletionOptions {
  mode: SelectiveDeletionMode | "RETENTION";
  target: DeletionTarget;
  dataDirectory: string;
  rawObservationIds?: readonly string[];
  spoolDeletePredicate?: (envelope: SpoolEnvelope) => boolean;
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
  let normalizedObservationsDeleted = 0;
  let analysisRunsDeleted = 0;
  let rawObservationsDeleted = 0;
  let sourceDeleted = 0;
  const sourceExternalKey = options.mode === "DELETE_SOURCE_SESSION"
    ? database.externalKeyForSourceObject(options.target.sourceObjectId!)
    : null;
  database.prepareSecureDeletion();
  database.transaction(() => {
    if (options.mode === "DELETE_RAW_ONLY" || options.mode === "RETENTION") {
      database.markEvidenceRemovedForRevisionIds(unique(raw.map((item) => item.sourceRevisionId)));
    } else {
      const derived = database.deleteDerivedForRevisionIds(revisionIds);
      normalizedObservationsDeleted = derived.normalizedObservations;
      analysisRunsDeleted = derived.analysisRuns;
    }
    if (options.mode === "DELETE_SOURCE_SESSION") {
      sourceDeleted = database.deleteSourceObject(options.target.sourceObjectId!);
      rawObservationsDeleted = raw.length;
    } else {
      rawObservationsDeleted = database.deleteRawObservations(raw.map((item) => item.id));
    }
  });
  if (options.mode === "DELETE_SOURCE_SESSION" && sourceDeleted === 0) {
    throw new Error("source object does not exist");
  }

  let blobsDeleted = 0;
  for (const reference of unique(raw.map((item) => item.payloadReference))) {
    if (database.rawReferenceCount(reference) === 0 && await blobs.remove(reference)) blobsDeleted += 1;
  }
  let spoolEntriesDeleted = 0;
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
    spoolEntriesDeleted = await new BoundedSpool(join(options.dataDirectory, "spool"))
      .deleteWhere((envelope: SpoolEnvelope) => hasSession(envelope.payload));
  } else if (options.spoolDeletePredicate) {
    spoolEntriesDeleted = await new BoundedSpool(join(options.dataDirectory, "spool"))
      .deleteWhere(options.spoolDeletePredicate);
  }
  const result: DeletionResult = {
    mode: options.mode,
    rawObservationsDeleted,
    normalizedObservationsDeleted,
    analysisRunsDeleted,
    blobsDeleted,
    spoolEntriesDeleted,
  };
  database.recordDeletion({
    id: `deletion_${options.randomId()}`,
    mode: options.mode,
    target: options.target,
    status: "COMPLETED",
    rawObservationsDeleted: result.rawObservationsDeleted,
    normalizedObservationsDeleted: result.normalizedObservationsDeleted,
    analysisRunsDeleted: result.analysisRunsDeleted,
    blobsDeleted: result.blobsDeleted,
    spoolEntriesDeleted: result.spoolEntriesDeleted,
    executedAt: options.now().toISOString(),
  });
  database.finalizeSecureDeletion();
  return result;
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
    database.saveCollectionPolicy(options.policy, now().toISOString());
    const cutoffs = new Map<DataClassification, string>();
    const eligible = Object.entries(options.policy.classifications).flatMap(([classification, rule]) => {
      if (rule.retentionDays === null) return [];
      if (!Number.isInteger(rule.retentionDays) || rule.retentionDays < 0) {
        throw new Error(`invalid retention days for ${classification}`);
      }
      const cutoff = new Date(now().getTime() - rule.retentionDays * 86_400_000).toISOString();
      cutoffs.set(classification as DataClassification, cutoff);
      return database.rawObservationsEligibleForRetention(classification as DataClassification, cutoff);
    });
    const rawIds = unique(eligible.map((item) => item.id));
    return await executeInternalDeletion(database, new ContentAddressedBlobStore(join(dataDirectory, "blobs")), {
      mode: "RETENTION",
      target: { revisionIds: unique(eligible.map((item) => item.sourceRevisionId)) },
      dataDirectory,
      rawObservationIds: rawIds,
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
