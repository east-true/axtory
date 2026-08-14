import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { analyzeFacts, FACT_ANALYZER_VERSION } from "../../analysis/fact-analyzer.js";
import { ContentAddressedBlobStore } from "../../core/blob-store.js";
import { canonicalJson, stableId } from "../../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../../core/data-directory.js";
import { OUTPUT_POLICY_VERSION, writeJsonAtomically } from "../../core/output.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY, policyAllows } from "../../core/policy.js";
import { persistCollectedRevision } from "../../core/revision-persistence.js";
import { AxtoryDatabase } from "../../core/storage.js";
import type { Derivation } from "../../core/records.js";
import { projectSession, type SessionProjection } from "../../projections/session.js";
import type { ClaudeDiscovery } from "./discovery.js";
import type { ClaudeHistoryApi } from "./history-api.js";
import { CLAUDE_NORMALIZER_VERSION, normalizeClaudeSession } from "./normalizer.js";
import { listAllMessages, listAllSessions, type ReturnedViewCoverage } from "./pagination.js";

const RAW_SESSION_LIMIT_BYTES = 64 * 1024 * 1024;

export interface ClaudeCollectionOptions {
  dataDirectory: string;
  jsonOutputPath: string;
  projectDirectory?: string;
  pageSize?: number;
  maxPages?: number;
  now?: () => Date;
  randomId?: () => string;
}

export interface ClaudeCollectionOutput {
  schemaVersion: "axtory.claude-collection-output.v1";
  collectionRunId: string;
  source: "CLAUDE_CODE";
  coverage: ReturnedViewCoverage;
  discovery: {
    environmentType: string;
    installation: string;
    dataRoot: string;
    authentication: string;
  };
  sessions: {
    returned: number;
    revisionsCreated: number;
    revisionsUnchanged: number;
    partialMessageViews: number;
    sourceChangedViews: number;
  };
  metrics: readonly {
    key: string;
    value: unknown;
    unit: string | null;
    derivation: Derivation;
    availability: string;
    reason: string | null;
    evidenceCount: number;
    evidenceStatus: "PRESENT" | "EVIDENCE_REMOVED" | "INVALIDATED";
  }[];
  limitations: readonly string[];
}

function capability(discovery: ClaudeDiscovery, key: string): string {
  return discovery.capabilityAssessment.capabilities.find((item) => item.key === key)?.availability
    ?? "UNKNOWN";
}

function validEpoch(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function collectClaudeHistory(
  api: ClaudeHistoryApi,
  discovery: ClaudeDiscovery,
  options: ClaudeCollectionOptions,
): Promise<ClaudeCollectionOutput> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const timestamp = () => now().toISOString();
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const blobs = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
  const collectionRunId = `collection_${randomId()}`;
  database.reconcileInterruptedRuns(timestamp());
  database.saveCollectionPolicy(DEFAULT_LOCAL_COLLECTION_POLICY, timestamp());
  database.startCollectionRun(collectionRunId, "CLAUDE_CODE", timestamp());
  try {
    const sessions = await listAllSessions(api, {
      ...(options.projectDirectory ? { dir: options.projectDirectory } : {}),
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
      ...(options.maxPages ? { maxPages: options.maxPages } : {}),
    });
    const projections: SessionProjection[] = [];
    const revisionIds: string[] = [];
    const revisionsWithoutRawEvidence = new Set<string>();
    let revisionsCreated = 0;
    let revisionsUnchanged = 0;
    let partialMessageViews = 0;
    let sourceChangedViews = 0;
    for (const session of sessions.items) {
      const sourceObjectId = stableId("source", { sourceType: "CLAUDE_CODE", sessionId: session.sessionId });
      const sourceModifiedAt = validEpoch(session.lastModified);
      const unchangedRevisionId = sourceModifiedAt
        ? database.findRevisionBySourceModifiedAt(sourceObjectId, sourceModifiedAt)
        : null;
      if (unchangedRevisionId) {
        if (!database.rawObservationForRevision(unchangedRevisionId)) {
          revisionsWithoutRawEvidence.add(unchangedRevisionId);
        }
        const projection = projectSession(database.observationsForRevision(unchangedRevisionId));
        projections.push(projection);
        if (projection.messageCoverage !== "COMPLETE_FOR_RETURNED_VIEW") partialMessageViews += 1;
        if (projection.messageCoverage === "PARTIAL_SOURCE_CHANGED") sourceChangedViews += 1;
        revisionIds.push(unchangedRevisionId);
        database.linkCollectionRevision(collectionRunId, sourceObjectId, unchangedRevisionId, timestamp());
        revisionsUnchanged += 1;
        continue;
      }
      const messages = await listAllMessages(api, session.sessionId, {
        ...(options.projectDirectory ? { dir: options.projectDirectory } : {}),
        ...(options.pageSize ? { pageSize: options.pageSize } : {}),
        ...(options.maxPages ? { maxPages: options.maxPages } : {}),
      });
      const afterRead = api.getSessionInfo
        ? await api.getSessionInfo(session.sessionId, {
          ...(options.projectDirectory ? { dir: options.projectDirectory } : {}),
        })
        : undefined;
      const messageCoverage = api.getSessionInfo &&
        (!afterRead || afterRead.lastModified !== session.lastModified)
        ? "PARTIAL_SOURCE_CHANGED"
        : messages.coverage === "COMPLETE_FOR_RETURNED_VIEW"
          ? "COMPLETE_FOR_RETURNED_VIEW"
          : "PARTIAL_PAGINATION";
      const rawJson = canonicalJson({ session, messages: messages.items });
      const rawBytes = new TextEncoder().encode(rawJson);
      if (rawBytes.byteLength > RAW_SESSION_LIMIT_BYTES) {
        throw new Error("a Claude session view exceeds the 64 MiB per-revision limit");
      }
      if (!policyAllows(DEFAULT_LOCAL_COLLECTION_POLICY, "CONVERSATION_CONTENT", "persist")) {
        throw new Error("collection policy does not allow local conversation persistence");
      }
      const blob = await blobs.put(rawBytes);
      const revisionId = stableId("revision", { sourceObjectId, contentHash: blob.digest });
      const persistedAt = timestamp();
      const { created } = persistCollectedRevision(database, {
        collectionRunId,
        sourceObject: { id: sourceObjectId, sourceType: "CLAUDE_CODE", externalKey: session.sessionId },
        revision: {
          id: revisionId, sourceObjectId, contentHash: blob.digest, collectedAt: persistedAt,
          sourceModifiedAt, normalizerVersion: CLAUDE_NORMALIZER_VERSION, payloadReference: blob.relativePath,
        },
        rawObservation: {
          id: stableId("raw", { revisionId, type: "VENDOR_SESSION_VIEW" }),
          sourceRevisionId: revisionId, observationType: "VENDOR_SESSION_VIEW", provenance: "OFFICIAL_API",
          dataClassification: "CONVERSATION_CONTENT", payloadReference: blob.relativePath,
          observedAt: persistedAt, sourceModifiedAt,
        },
        observations: normalizeClaudeSession(session, messages.items, revisionId, messageCoverage),
        observedAt: persistedAt,
      });
      if (created) revisionsCreated += 1;
      else revisionsUnchanged += 1;
      const projection = projectSession(database.observationsForRevision(revisionId));
      projections.push(projection);
      if (projection.messageCoverage !== "COMPLETE_FOR_RETURNED_VIEW") partialMessageViews += 1;
      if (projection.messageCoverage === "PARTIAL_SOURCE_CHANGED") sourceChangedViews += 1;
      revisionIds.push(revisionId);
    }
    const analysisRunId = `analysis_${randomId()}`;
    database.startAnalysisRun({
      id: analysisRunId,
      analyzerType: "FACT_ANALYZER",
      analyzerVersion: FACT_ANALYZER_VERSION,
      inputRevisionIds: revisionIds,
      startedAt: timestamp(),
    });
    const records = analyzeFacts(analysisRunId, projections).map((record) => ({
      ...record,
      evidenceStatus: record.evidenceIds.some((id) => projections.some((projection) =>
        revisionsWithoutRawEvidence.has(projection.sourceRevisionId) &&
        [...projection.sessionEvidenceIds, ...projection.messageEvidenceIds, ...projection.toolInvocationEvidenceIds]
          .includes(id)))
        ? "EVIDENCE_REMOVED" as const
        : record.evidenceStatus,
    }));
    database.transaction(() => database.insertAnalysisRecords(records));
    database.finishAnalysisRun(analysisRunId, "COMPLETED", timestamp());
    const coverage = sessions.coverage !== "COMPLETE_FOR_RETURNED_VIEW"
      ? "PARTIAL_PAGINATION"
      : sourceChangedViews > 0
        ? "PARTIAL_SOURCE_CHANGED"
        : partialMessageViews > 0
          ? "PARTIAL_PAGINATION"
          : "COMPLETE_FOR_RETURNED_VIEW";
    const output: ClaudeCollectionOutput = {
      schemaVersion: "axtory.claude-collection-output.v1",
      collectionRunId,
      source: "CLAUDE_CODE",
      coverage,
      discovery: {
        environmentType: discovery.environment.type,
        installation: capability(discovery, "claude.installation"),
        dataRoot: capability(discovery, "claude.data_root"),
        authentication: capability(discovery, "claude.auth"),
      },
      sessions: {
        returned: sessions.items.length,
        revisionsCreated,
        revisionsUnchanged,
        partialMessageViews,
        sourceChangedViews,
      },
      metrics: records.map((item) => ({
        key: item.key,
        value: item.value,
        unit: item.unit,
        derivation: item.derivation,
        availability: item.availability,
        reason: item.reason,
        evidenceCount: item.evidenceIds.length,
        evidenceStatus: item.evidenceStatus,
      })),
      limitations: [
        "Counts describe the official API returned view, not completed work items.",
        "Prompt, response, and tool payload content is persisted only in the local raw blob store and excluded from this output.",
        "History retention, compaction, and concurrent active-session changes can make the returned view incomplete.",
      ],
    };
    const payloadDigest = await writeJsonAtomically(options.jsonOutputPath, output);
    database.recordExport({
      id: `export_${randomId()}`,
      sink: "JSON_FILE",
      destination: options.jsonOutputPath,
      policyVersion: OUTPUT_POLICY_VERSION,
      recordCount: output.metrics.length,
      classifications: ["PUBLIC_METADATA"],
      status: "COMPLETED",
      payloadDigest,
      exportedAt: timestamp(),
    });
    database.finishCollectionRun(collectionRunId, "COMPLETED", timestamp());
    return output;
  } catch (error) {
    database.finishCollectionRun(collectionRunId, "FAILED", timestamp(), "COLLECTION_ERROR");
    throw error;
  } finally {
    database.close();
  }
}

export function renderClaudeCollection(output: ClaudeCollectionOutput): string {
  const lines = [
    "AXtory Claude Code history",
    `Coverage: ${output.coverage}`,
    `Sessions returned: ${output.sessions.returned}`,
    `Revisions created: ${output.sessions.revisionsCreated}`,
    `Revisions unchanged: ${output.sessions.revisionsUnchanged}`,
  ];
  for (const metric of output.metrics) {
    lines.push(metric.availability === "AVAILABLE"
      ? `${metric.key}: ${String(metric.value)} ${metric.unit ?? ""} [${metric.derivation}]`
      : `${metric.key}: unavailable [${metric.availability}] Reason: ${metric.reason ?? "unknown"}`);
  }
  return `${lines.join("\n").slice(0, 16_384)}\n`;
}
