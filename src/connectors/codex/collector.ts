import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { analyzeFacts, FACT_ANALYZER_VERSION } from "../../analysis/fact-analyzer.js";
import { ContentAddressedBlobStore } from "../../core/blob-store.js";
import { canonicalJson, stableId } from "../../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../../core/data-directory.js";
import { OUTPUT_POLICY_VERSION, writeJsonAtomically } from "../../core/output.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY, policyAllows } from "../../core/policy.js";
import type { Derivation } from "../../core/records.js";
import { persistCollectedRevision } from "../../core/revision-persistence.js";
import { AxtoryDatabase } from "../../core/storage.js";
import { projectSession, type SessionProjection } from "../../projections/session.js";
import type { CodexDiscovery } from "./discovery.js";
import { CODEX_NORMALIZER_VERSION, normalizeCodexThread, type CodexMessageCoverage } from "./normalizer.js";
import { listAllCodexThreads } from "./pagination.js";
import { CodexRequestError } from "./app-server.js";
import type { CodexThread, CodexThreadApi } from "./types.js";

const RAW_THREAD_LIMIT_BYTES = 64 * 1024 * 1024;

export interface CodexCollectionOptions {
  dataDirectory: string; jsonOutputPath: string; pageSize?: number; maxPages?: number;
  now?: () => Date; randomId?: () => string;
}

export interface CodexCollectionOutput {
  schemaVersion: "axtory.codex-collection-output.v1";
  collectionRunId: string;
  source: "CODEX";
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION" | "PARTIAL_COMPACTION"
    | "PARTIAL_SOURCE_CHANGED" | "PARTIAL_UNSETTLED_TURN" | "PARTIAL_UNREADABLE_THREAD";
  discovery: { environmentType: string; installation: string; state: string; login: string };
  threads: {
    returned: number; revisionsCreated: number; revisionsUnchanged: number; activeViews: number;
    unsettledTurnViews: number; compactedViews: number; partialItemViews: number;
    unreadableThreads: number; unreadableReasons: readonly string[];
  };
  metrics: readonly {
    key: string; value: unknown; unit: string | null; derivation: Derivation; availability: string;
    reason: string | null; evidenceCount: number;
    evidenceStatus: "PRESENT" | "EVIDENCE_REMOVED" | "INVALIDATED";
  }[];
  limitations: readonly string[];
}

function capability(discovery: CodexDiscovery, key: string): string {
  return discovery.capabilityAssessment.capabilities.find((item) => item.key === key)?.availability ?? "UNKNOWN";
}

function epochSeconds(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function viewCoverage(listed: CodexThread, detail: CodexThread): CodexMessageCoverage {
  if (listed.status?.type === "active" || detail.status?.type === "active" || listed.updatedAt !== detail.updatedAt) {
    return "PARTIAL_SOURCE_CHANGED";
  }
  if (detail.turns.some((turn) => turn.completedAt === null)) return "PARTIAL_UNSETTLED_TURN";
  if (detail.turns.some((turn) => turn.items.some((item) => item.type === "contextCompaction"))) {
    return "PARTIAL_COMPACTION";
  }
  if (detail.turns.some((turn) => turn.itemsView !== "full")) return "PARTIAL_PAGINATION";
  return "COMPLETE_FOR_RETURNED_VIEW";
}

export async function collectCodexHistory(
  api: CodexThreadApi, discovery: CodexDiscovery, options: CodexCollectionOptions,
): Promise<CodexCollectionOutput> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const timestamp = () => now().toISOString();
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const blobs = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
  const collectionRunId = `collection_${randomId()}`;
  database.reconcileInterruptedRuns(timestamp());
  database.saveCollectionPolicy(DEFAULT_LOCAL_COLLECTION_POLICY, timestamp());
  database.startCollectionRun(collectionRunId, "CODEX", timestamp());
  try {
    const listed = await listAllCodexThreads(api, {
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
      ...(options.maxPages ? { maxPages: options.maxPages } : {}),
    });
    const projections: SessionProjection[] = [];
    const revisionIds: string[] = [];
    const revisionsWithoutRawEvidence = new Set<string>();
    let revisionsCreated = 0, revisionsUnchanged = 0, activeViews = 0, compactedViews = 0;
    let partialItemViews = 0, sourceChangedViews = 0, unsettledTurnViews = 0, unreadableThreads = 0;
    const unreadableReasons = new Set<string>();
    for (const summary of listed.items) {
      const sourceObjectId = stableId("source", { sourceType: "CODEX", threadId: summary.id });
      const sourceModifiedAt = epochSeconds(summary.updatedAt);
      const unchangedRevisionId = summary.status?.type !== "active" && sourceModifiedAt
        ? database.findRevisionBySourceModifiedAt(sourceObjectId, sourceModifiedAt)
        : null;
      if (unchangedRevisionId) {
        if (!database.rawObservationForRevision(unchangedRevisionId)) revisionsWithoutRawEvidence.add(unchangedRevisionId);
        const projection = projectSession(database.observationsForRevision(unchangedRevisionId));
        projections.push(projection);
        if (projection.messageCoverage === "PARTIAL_COMPACTION") compactedViews += 1;
        if (projection.messageCoverage === "PARTIAL_PAGINATION") partialItemViews += 1;
        if (projection.messageCoverage === "PARTIAL_SOURCE_CHANGED") sourceChangedViews += 1;
        if (projection.messageCoverage === "PARTIAL_UNSETTLED_TURN") unsettledTurnViews += 1;
        revisionIds.push(unchangedRevisionId);
        database.linkCollectionRevision(collectionRunId, sourceObjectId, unchangedRevisionId, timestamp());
        revisionsUnchanged += 1;
        continue;
      }
      let detail: CodexThread;
      try { detail = await api.readThread(summary.id); }
      catch (error) {
        if (!(error instanceof CodexRequestError)) throw error;
        unreadableThreads += 1; unreadableReasons.add(error.message.slice(0, 200)); continue;
      }
      const coverage = viewCoverage(summary, detail);
      if (coverage === "PARTIAL_SOURCE_CHANGED") { activeViews += 1; sourceChangedViews += 1; }
      if (coverage === "PARTIAL_COMPACTION") compactedViews += 1;
      if (coverage === "PARTIAL_PAGINATION") partialItemViews += 1;
      if (coverage === "PARTIAL_UNSETTLED_TURN") unsettledTurnViews += 1;
      const rawBytes = new TextEncoder().encode(canonicalJson({ thread: detail }));
      if (rawBytes.byteLength > RAW_THREAD_LIMIT_BYTES) throw new Error("a Codex thread view exceeds the 64 MiB per-revision limit");
      if (!policyAllows(DEFAULT_LOCAL_COLLECTION_POLICY, "CONVERSATION_CONTENT", "persist")) {
        throw new Error("collection policy does not allow local conversation persistence");
      }
      const blob = await blobs.put(rawBytes);
      const revisionId = stableId("revision", { sourceObjectId, contentHash: blob.digest });
      const persistedAt = timestamp();
      const detailModifiedAt = epochSeconds(detail.updatedAt);
      const { created } = await persistCollectedRevision(database, {
        dataDirectory, collectionRunId,
        sourceObject: { id: sourceObjectId, sourceType: "CODEX", externalKey: summary.id },
        revision: {
          id: revisionId, sourceObjectId, contentHash: blob.digest, collectedAt: persistedAt,
          sourceModifiedAt: detailModifiedAt, normalizerVersion: CODEX_NORMALIZER_VERSION, payloadReference: blob.relativePath,
        },
        rawObservation: {
          id: stableId("raw", { revisionId, type: "CODEX_THREAD_VIEW" }), sourceRevisionId: revisionId,
          observationType: "CODEX_THREAD_VIEW", provenance: "OFFICIAL_API", dataClassification: "CONVERSATION_CONTENT",
          payloadReference: blob.relativePath, observedAt: persistedAt, sourceModifiedAt: detailModifiedAt,
        },
        observations: normalizeCodexThread(detail, revisionId, coverage), observedAt: persistedAt,
      });
      if (created) revisionsCreated += 1; else revisionsUnchanged += 1;
      projections.push(projectSession(database.observationsForRevision(revisionId)));
      revisionIds.push(revisionId);
    }
    const analysisRunId = `analysis_${randomId()}`;
    database.startAnalysisRun({ id: analysisRunId, analyzerType: "FACT_ANALYZER", analyzerVersion: FACT_ANALYZER_VERSION,
      inputRevisionIds: revisionIds, startedAt: timestamp() });
    const sourceSetComplete = listed.coverage === "COMPLETE_FOR_RETURNED_VIEW" && unreadableThreads === 0;
    const records = analyzeFacts(analysisRunId, projections, { sourceSetComplete }).map((record) => ({
      ...record,
      evidenceStatus: record.evidenceIds.some((id) => projections.some((projection) =>
        revisionsWithoutRawEvidence.has(projection.sourceRevisionId) &&
        [...projection.sessionEvidenceIds, ...projection.messageEvidenceIds, ...projection.toolInvocationEvidenceIds].includes(id)))
        ? "EVIDENCE_REMOVED" as const : record.evidenceStatus,
    }));
    database.transaction(() => database.insertAnalysisRecords(records));
    database.finishAnalysisRun(analysisRunId, "COMPLETED", timestamp());
    const coverage = unreadableThreads > 0 ? "PARTIAL_UNREADABLE_THREAD"
      : listed.coverage !== "COMPLETE_FOR_RETURNED_VIEW" ? "PARTIAL_PAGINATION"
      : sourceChangedViews > 0 ? "PARTIAL_SOURCE_CHANGED"
      : unsettledTurnViews > 0 ? "PARTIAL_UNSETTLED_TURN"
      : partialItemViews > 0 ? "PARTIAL_PAGINATION"
      : compactedViews > 0 ? "PARTIAL_COMPACTION" : "COMPLETE_FOR_RETURNED_VIEW";
    const output: CodexCollectionOutput = {
      schemaVersion: "axtory.codex-collection-output.v1", collectionRunId, source: "CODEX", coverage,
      discovery: { environmentType: discovery.environment.type, installation: capability(discovery, "codex.installation"),
        state: capability(discovery, "codex.state"), login: capability(discovery, "codex.login") },
      threads: { returned: listed.items.length, revisionsCreated, revisionsUnchanged, activeViews, unsettledTurnViews,
        compactedViews, partialItemViews, unreadableThreads, unreadableReasons: [...unreadableReasons] },
      metrics: records.map((item) => ({ key: item.key, value: item.value, unit: item.unit, derivation: item.derivation,
        availability: item.availability, reason: item.reason, evidenceCount: item.evidenceIds.length,
        evidenceStatus: item.evidenceStatus })),
      limitations: [
        "Counts describe official App Server returned views, not completed work items.",
        "App Server runs against a temporary SQLite backup because startup writes runtime state even for read methods.",
        "Thread rollout content is read through thread/read; AXtory does not parse Codex JSONL storage.",
        "Active, compacted, or non-full item views remain explicitly partial.",
        "A thread the App Server refuses to return is counted as unreadable rather than collected; the run stays partial instead of discarding the threads it did read.",
        "Conversation and tool content stays in the local raw blob store and is excluded from this output.",
      ],
    };
    const payloadDigest = await writeJsonAtomically(options.jsonOutputPath, output);
    database.recordExport({ id: `export_${randomId()}`, sink: "JSON_FILE", destination: options.jsonOutputPath,
      policyVersion: OUTPUT_POLICY_VERSION, recordCount: output.metrics.length, classifications: ["PUBLIC_METADATA"],
      status: "COMPLETED", payloadDigest, exportedAt: timestamp() });
    database.finishCollectionRun(collectionRunId, "COMPLETED", timestamp());
    return output;
  } catch (error) {
    database.finishCollectionRun(collectionRunId, "FAILED", timestamp(), "COLLECTION_ERROR"); throw error;
  } finally { database.close(); }
}

export function renderCodexCollection(output: CodexCollectionOutput): string {
  const lines = ["AXtory Codex history", `Coverage: ${output.coverage}`, `Threads returned: ${output.threads.returned}`,
    `Revisions created: ${output.threads.revisionsCreated}`, `Revisions unchanged: ${output.threads.revisionsUnchanged}`,
    ...(output.threads.unreadableThreads === 0 ? [] : [`Unreadable threads: ${output.threads.unreadableThreads} (no view collected)`,
      ...output.threads.unreadableReasons.map((reason) => `  reason: ${reason}`)])];
  for (const metric of output.metrics) lines.push(metric.availability === "AVAILABLE"
    ? `${metric.key}: ${String(metric.value)} ${metric.unit ?? ""} [${metric.derivation}]`
    : `${metric.key}: unavailable [${metric.availability}] Reason: ${metric.reason ?? "unknown"}`);
  return `${lines.join("\n").slice(0, 16_384)}\n`;
}
