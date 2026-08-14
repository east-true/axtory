import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { analyzeAdditionalAiFacts, ADDITIONAL_AI_FACT_ANALYZER_VERSION } from "../../analysis/additional-ai-analyzer.js";
import { ContentAddressedBlobStore } from "../../core/blob-store.js";
import { canonicalJson, stableId } from "../../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../../core/data-directory.js";
import { writeAuditedJsonAtomically } from "../../core/export.js";
import { OUTPUT_POLICY_VERSION } from "../../core/output.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY, policyAllows } from "../../core/policy.js";
import type { AnalysisRecord } from "../../core/records.js";
import { persistCollectedRevision } from "../../core/revision-persistence.js";
import { AxtoryDatabase } from "../../core/storage.js";
import { projectSession, type SessionProjection } from "../../projections/session.js";
import type { AdditionalAiDiscovery } from "./discovery.js";
import { ADDITIONAL_AI_NORMALIZER_VERSION, normalizeAdditionalAiSession } from "./normalizer.js";
import type { AdditionalAiCoverage, AdditionalAiSourceApi } from "./types.js";

const RAW_VIEW_LIMIT_BYTES = 64 * 1024 * 1024;

export interface AdditionalAiCollectionOutput {
  schemaVersion: "axtory.additional-ai-collection-output.v1";
  collectionRunId: string;
  provider: AdditionalAiSourceApi["provider"];
  coverage: AdditionalAiCoverage;
  discovery: { installation: string; enumeration: string; content: string };
  sessions: {
    returned: number;
    revisionsCreated: number;
    revisionsUnchanged: number;
    structuredViews: number;
    metadataOnlyViews: number;
    unstructuredViews: number;
  };
  metrics: readonly {
    key: string;
    value: unknown;
    unit: string | null;
    derivation: AnalysisRecord["derivation"];
    availability: string;
    reason: string | null;
    evidenceCount: number;
    evidenceStatus: AnalysisRecord["evidenceStatus"];
  }[];
  limitations: readonly string[];
}

function capability(discovery: AdditionalAiDiscovery, key: string): string {
  return discovery.capabilityAssessment.capabilities.find((item) => item.key === key)?.availability ?? "UNKNOWN";
}

function retainedCoverage(observations: ReturnType<AxtoryDatabase["observationsForRevision"]>): AdditionalAiCoverage {
  const value = observations.find((item) => item.stableKey === "session")?.payload.additionalAiCoverage;
  return value === "COMPLETE_FOR_RETURNED_VIEW" || value === "PARTIAL_LIMIT" ||
    value === "PARTIAL_SOURCE_CHANGED" || value === "PARTIAL_COMPACTION" ||
    value === "METADATA_ONLY" || value === "UNKNOWN"
    ? value
    : "UNKNOWN";
}

export async function collectAdditionalAiSource(
  api: AdditionalAiSourceApi,
  discovery: AdditionalAiDiscovery,
  options: {
    dataDirectory: string;
    jsonOutputPath: string;
    limit?: number;
    now?: () => Date;
    randomId?: () => string;
  },
): Promise<AdditionalAiCollectionOutput> {
  if (api.provider !== discovery.provider) throw new Error("additional AI discovery does not match the adapter");
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("additional AI session limit must be an integer between 1 and 10000");
  }
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const timestamp = () => now().toISOString();
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const databasePath = join(dataDirectory, "axtory.sqlite3");
  const database = new AxtoryDatabase(databasePath);
  const blobs = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
  const collectionRunId = `collection_${randomId()}`;
  const sourceType = `ADDITIONAL_AI_${api.provider}`;
  database.reconcileInterruptedRuns(timestamp());
  database.saveCollectionPolicy(DEFAULT_LOCAL_COLLECTION_POLICY, timestamp());
  database.startCollectionRun(collectionRunId, sourceType, timestamp());
  try {
    const listed = await api.listSessions({ limit });
    const projections: SessionProjection[] = [];
    const revisionIds: string[] = [];
    const missingRawRevisions = new Set<string>();
    const viewCoverages: AdditionalAiCoverage[] = [];
    let revisionsCreated = 0;
    let revisionsUnchanged = 0;
    let structuredViews = 0;
    let metadataOnlyViews = 0;
    let unstructuredViews = 0;
    for (const summary of listed.items) {
      if (summary.provider !== api.provider || summary.scopeIdentity !== api.scopeIdentity) {
        throw new Error("additional AI adapter returned a session outside its configured scope");
      }
      const sourceObjectId = stableId("source", {
        sourceType, scopeIdentity: api.scopeIdentity, externalId: summary.externalId,
      });
      const externalKey = `${api.scopeIdentity}:${summary.externalId}`;
      const unchangedRevisionId = summary.sourceUpdatedAt
        ? database.findRevisionBySourceModifiedAt(sourceObjectId, summary.sourceUpdatedAt)
        : null;
      if (unchangedRevisionId) {
        if (!database.rawObservationForRevision(unchangedRevisionId)) missingRawRevisions.add(unchangedRevisionId);
        const observations = database.observationsForRevision(unchangedRevisionId);
        const projection = projectSession(observations);
        projections.push(projection);
        revisionIds.push(unchangedRevisionId);
        const savedCoverage = retainedCoverage(observations);
        viewCoverages.push(savedCoverage);
        if (api.provider === "AIDER") unstructuredViews += 1;
        else if (api.provider === "GEMINI_CLI" || api.provider === "CURSOR") metadataOnlyViews += 1;
        else structuredViews += 1;
        database.linkCollectionRevision(collectionRunId, sourceObjectId, unchangedRevisionId, timestamp());
        revisionsUnchanged += 1;
        continue;
      }
      const view = await api.readSession(summary);
      const rawBytes = new TextEncoder().encode(canonicalJson({
        schemaVersion: "axtory.additional-ai-source-view.v1",
        provider: api.provider,
        view: view.rawPayload,
      }));
      if (rawBytes.byteLength > RAW_VIEW_LIMIT_BYTES) throw new Error("an additional AI source view exceeds 64 MiB");
      if (!policyAllows(DEFAULT_LOCAL_COLLECTION_POLICY, view.dataClassification, "persist")) {
        throw new Error("collection policy does not allow additional AI source persistence");
      }
      const blob = await blobs.put(rawBytes);
      const revisionId = stableId("revision", { sourceObjectId, contentHash: blob.digest });
      const persistedAt = timestamp();
      const { created } = await persistCollectedRevision(database, {
        dataDirectory,
        collectionRunId,
        sourceObject: { id: sourceObjectId, sourceType, externalKey },
        revision: {
          id: revisionId, sourceObjectId, contentHash: blob.digest, collectedAt: persistedAt,
          sourceModifiedAt: view.summary.sourceUpdatedAt,
          normalizerVersion: ADDITIONAL_AI_NORMALIZER_VERSION, payloadReference: blob.relativePath,
        },
        rawObservation: {
          id: stableId("raw", { revisionId, type: "ADDITIONAL_AI_VIEW" }),
          sourceRevisionId: revisionId, observationType: "ADDITIONAL_AI_VIEW",
          provenance: view.provenance, dataClassification: view.dataClassification,
          payloadReference: blob.relativePath, observedAt: persistedAt,
          sourceModifiedAt: view.summary.sourceUpdatedAt,
        },
        observations: normalizeAdditionalAiSession(view, revisionId),
        observedAt: persistedAt,
      });
      if (created) revisionsCreated += 1;
      else revisionsUnchanged += 1;
      projections.push(projectSession(database.observationsForRevision(revisionId)));
      revisionIds.push(revisionId);
      viewCoverages.push(view.coverage);
      if (api.provider === "AIDER") unstructuredViews += 1;
      else if (api.provider === "GEMINI_CLI" || api.provider === "CURSOR") metadataOnlyViews += 1;
      else structuredViews += 1;
    }
    const analysisRunId = `analysis_${randomId()}`;
    database.startAnalysisRun({
      id: analysisRunId, analyzerType: "ADDITIONAL_AI_FACT_ANALYZER",
      analyzerVersion: ADDITIONAL_AI_FACT_ANALYZER_VERSION,
      inputRevisionIds: revisionIds, startedAt: timestamp(),
    });
    const records = analyzeAdditionalAiFacts(
      analysisRunId,
      api.provider,
      projections,
      listed.coverage !== "PARTIAL_LIMIT",
    ).map((record) => ({
      ...record,
      evidenceStatus: record.evidenceIds.some((id) => projections.some((projection) =>
        missingRawRevisions.has(projection.sourceRevisionId) &&
        [...projection.sessionEvidenceIds, ...projection.messageEvidenceIds, ...projection.toolInvocationEvidenceIds]
          .includes(id)))
        ? "EVIDENCE_REMOVED" as const
        : record.evidenceStatus,
    }));
    database.transaction(() => database.insertAnalysisRecords(records));
    database.finishAnalysisRun(analysisRunId, "COMPLETED", timestamp());
    const coverage: AdditionalAiCoverage = listed.coverage === "PARTIAL_LIMIT"
      ? "PARTIAL_LIMIT"
      : listed.coverage === "METADATA_ONLY" && viewCoverages.length === 0
        ? "METADATA_ONLY"
      : viewCoverages.includes("PARTIAL_LIMIT")
        ? "PARTIAL_LIMIT"
      : viewCoverages.includes("PARTIAL_SOURCE_CHANGED")
        ? "PARTIAL_SOURCE_CHANGED"
      : viewCoverages.includes("PARTIAL_COMPACTION")
        ? "PARTIAL_COMPACTION"
        : viewCoverages.length > 0 && viewCoverages.every((value) => value === "METADATA_ONLY")
          ? "METADATA_ONLY"
          : viewCoverages.includes("UNKNOWN")
            ? "UNKNOWN"
            : "COMPLETE_FOR_RETURNED_VIEW";
    const output: AdditionalAiCollectionOutput = {
      schemaVersion: "axtory.additional-ai-collection-output.v1",
      collectionRunId, provider: api.provider, coverage,
      discovery: {
        installation: capability(discovery, "additional_ai.installation"),
        enumeration: capability(discovery, "additional_ai.session_enumeration"),
        content: capability(discovery, "additional_ai.session_content"),
      },
      sessions: {
        returned: projections.length, revisionsCreated, revisionsUnchanged,
        structuredViews, metadataOnlyViews, unstructuredViews,
      },
      metrics: records.map((record) => ({
        key: record.key, value: record.value, unit: record.unit, derivation: record.derivation,
        availability: record.availability, reason: record.reason,
        evidenceCount: record.evidenceIds.length, evidenceStatus: record.evidenceStatus,
      })),
      limitations: [
        "Session counts describe the configured provider's returned view, not completed work.",
        "Conversation, tool, path, model, and identity values are excluded from Console and JSON output.",
        "Gemini CLI and Cursor expose list/resume but no non-mutating structured history export.",
        "Aider Markdown is retained as local raw evidence without inventing message boundaries.",
        "Only OpenCode's official JSON export currently supports message and tool occurrence facts.",
      ],
    };
    await writeAuditedJsonAtomically({
      databasePath,
      jsonOutputPath: options.jsonOutputPath,
      output,
      audit: {
        id: `export_${randomId()}`,
        policyVersion: OUTPUT_POLICY_VERSION,
        recordCount: output.metrics.length,
        classifications: ["LOCAL_METADATA"],
      },
      now: timestamp,
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

export function renderAdditionalAiCollection(output: AdditionalAiCollectionOutput): string {
  const lines = [
    `AXtory ${output.provider} evidence`,
    `Coverage: ${output.coverage}`,
    `Sessions returned: ${output.sessions.returned}`,
    `Revisions created: ${output.sessions.revisionsCreated}`,
    `Revisions unchanged: ${output.sessions.revisionsUnchanged}`,
  ];
  for (const metric of output.metrics) {
    lines.push(metric.availability === "AVAILABLE" || metric.availability === "PARTIAL"
      ? `${metric.key}: ${String(metric.value)} ${metric.unit ?? ""} [${metric.availability}]`
      : `${metric.key}: unavailable [${metric.availability}] Reason: ${metric.reason ?? "unknown"}`);
  }
  return `${lines.join("\n").slice(0, 16_384)}\n`;
}
