import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { analyzeWorkFacts, WORK_FACT_ANALYZER_VERSION } from "../../analysis/work-analyzer.js";
import { correlateWorkWithGit, WORK_GIT_CORRELATION_VERSION } from "../../analysis/work-git-correlation.js";
import { ContentAddressedBlobStore } from "../../core/blob-store.js";
import { canonicalJson, stableId } from "../../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../../core/data-directory.js";
import { OUTPUT_POLICY_VERSION, writeJsonAtomically } from "../../core/output.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY, policyAllows } from "../../core/policy.js";
import type { AnalysisRecord } from "../../core/records.js";
import { AxtoryDatabase } from "../../core/storage.js";
import { projectWorkArtifact, type WorkArtifactProjection } from "../../projections/work-artifact.js";
import { WORK_SYSTEM_NORMALIZER_VERSION, normalizeWorkArtifact } from "./normalizer.js";
import { enumerateWorkArtifacts } from "./pagination.js";
import type {
  WorkArtifactKind,
  WorkStatusCategory,
  WorkSystemApi,
  WorkSystemDiscovery,
} from "./types.js";

const RAW_ARTIFACT_LIMIT_BYTES = 2 * 1024 * 1024;

export interface WorkSystemCollectionOutput {
  schemaVersion: "axtory.work-system-collection-output.v1";
  collectionRunId: string;
  provider: WorkSystemDiscovery["provider"];
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION";
  authentication: WorkSystemDiscovery["authentication"];
  artifacts: {
    returned: number;
    revisionsCreated: number;
    revisionsUnchanged: number;
    byKind: Readonly<Record<WorkArtifactKind, number | null>>;
    byStatus: Readonly<Record<WorkStatusCategory, number>>;
  };
  repositoryLinks: {
    matched: number;
    derivation: "OBSERVED";
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

export async function collectWorkSystem(
  api: WorkSystemApi,
  discovery: WorkSystemDiscovery,
  options: {
    dataDirectory: string;
    jsonOutputPath: string;
    pageSize?: number;
    maxPages?: number;
    now?: () => Date;
    randomId?: () => string;
    gitRevisionId?: string;
  },
): Promise<WorkSystemCollectionOutput> {
  if (api.provider !== discovery.provider || api.scopeIdentity !== discovery.scopeIdentity) {
    throw new Error("work-system discovery does not match the configured adapter");
  }
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const timestamp = () => now().toISOString();
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const blobs = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
  const collectionRunId = `collection_${randomId()}`;
  const sourceType = `WORK_SYSTEM_${api.provider}`;
  database.reconcileInterruptedRuns(timestamp());
  database.saveCollectionPolicy(DEFAULT_LOCAL_COLLECTION_POLICY, timestamp());
  database.startCollectionRun(collectionRunId, sourceType, timestamp());
  try {
    const enumeration = await enumerateWorkArtifacts(api, {
      ...(options.pageSize ? { pageSize: options.pageSize } : {}),
      ...(options.maxPages ? { maxPages: options.maxPages } : {}),
    });
    const projections: WorkArtifactProjection[] = [];
    const revisionIds: string[] = [];
    const missingRawRevisions = new Set<string>();
    let revisionsCreated = 0;
    let revisionsUnchanged = 0;
    for (const artifact of enumeration.items) {
      const sourceObjectId = stableId("source", {
        sourceType, scopeIdentity: api.scopeIdentity, kind: artifact.kind, externalId: artifact.externalId,
      });
      database.upsertSourceObject(
        sourceObjectId,
        sourceType,
        `${api.scopeIdentity}:${artifact.kind}:${artifact.externalId}`,
      );
      const unchangedRevisionId = artifact.sourceUpdatedAt
        ? database.findRevisionBySourceModifiedAt(sourceObjectId, artifact.sourceUpdatedAt)
        : null;
      if (unchangedRevisionId) {
        if (!database.rawObservationForRevision(unchangedRevisionId)) missingRawRevisions.add(unchangedRevisionId);
        projections.push(projectWorkArtifact(database.observationsForRevision(unchangedRevisionId)));
        revisionIds.push(unchangedRevisionId);
        revisionsUnchanged += 1;
        continue;
      }
      const bytes = new TextEncoder().encode(canonicalJson({
        schemaVersion: "axtory.work-system-source-view.v1",
        provider: artifact.provider,
        scopeIdentity: artifact.scopeIdentity,
        kind: artifact.kind,
        artifact: artifact.sourceView,
      }));
      if (bytes.byteLength > RAW_ARTIFACT_LIMIT_BYTES) {
        throw new Error("a work-system artifact exceeds the 2 MiB per-revision limit");
      }
      if (!policyAllows(DEFAULT_LOCAL_COLLECTION_POLICY, "LOCAL_METADATA", "persist")) {
        throw new Error("collection policy does not allow work-system metadata persistence");
      }
      const blob = await blobs.put(bytes);
      const revisionId = stableId("revision", { sourceObjectId, contentHash: blob.digest });
      const created = database.insertRevision({
        id: revisionId, sourceObjectId, contentHash: blob.digest, collectedAt: timestamp(),
        sourceModifiedAt: artifact.sourceUpdatedAt,
        normalizerVersion: WORK_SYSTEM_NORMALIZER_VERSION,
        payloadReference: blob.relativePath,
      });
      if (created) revisionsCreated += 1;
      else revisionsUnchanged += 1;
      database.transaction(() => {
        database.insertRawObservation({
          id: stableId("raw", { revisionId, type: "WORK_SYSTEM_VIEW" }),
          sourceRevisionId: revisionId,
          observationType: "WORK_SYSTEM_VIEW",
          provenance: "EXTERNAL_API",
          dataClassification: "LOCAL_METADATA",
          payloadReference: blob.relativePath,
          observedAt: timestamp(),
          sourceModifiedAt: artifact.sourceUpdatedAt,
        });
        database.insertObservations(normalizeWorkArtifact(artifact, revisionId));
      });
      projections.push(projectWorkArtifact(database.observationsForRevision(revisionId)));
      revisionIds.push(revisionId);
    }
    const gitObservations = options.gitRevisionId
      ? database.observationsForRevision(options.gitRevisionId)
      : [];
    if (options.gitRevisionId && gitObservations.length === 0) {
      throw new Error("Local Git revision for work-system correlation does not exist");
    }
    const analysisRunId = `analysis_${randomId()}`;
    database.startAnalysisRun({
      id: analysisRunId,
      analyzerType: "WORK_FACT_ANALYZER",
      analyzerVersion: options.gitRevisionId
        ? `${WORK_FACT_ANALYZER_VERSION}+${WORK_GIT_CORRELATION_VERSION}`
        : WORK_FACT_ANALYZER_VERSION,
      inputRevisionIds: options.gitRevisionId ? [...revisionIds, options.gitRevisionId] : revisionIds,
      startedAt: timestamp(),
    });
    const removedEvidence = new Set(projections
      .filter((projection) => missingRawRevisions.has(projection.sourceRevisionId))
      .map((projection) => projection.artifactEvidenceId));
    const metricRecords = analyzeWorkFacts(
      analysisRunId, projections, api.supportedKinds, enumeration.coverage,
    ).map((record) => ({
      ...record,
      evidenceStatus: record.evidenceIds.some((id) => removedEvidence.has(id))
        ? "EVIDENCE_REMOVED" as const
        : record.evidenceStatus,
    }));
    const workObservations = revisionIds.flatMap((revisionId) => database.observationsForRevision(revisionId));
    const correlationRecords = correlateWorkWithGit(analysisRunId, workObservations, gitObservations);
    database.transaction(() => database.insertAnalysisRecords([...metricRecords, ...correlationRecords]));
    database.finishAnalysisRun(analysisRunId, "COMPLETED", timestamp());
    const byKind = Object.fromEntries((["CHANGE_REQUEST", "CI_RUN", "DEPLOYMENT", "WORK_ITEM"] as const)
      .map((kind) => [kind, api.supportedKinds.includes(kind)
        ? projections.filter((item) => item.artifactKind === kind).length
        : null])) as Record<WorkArtifactKind, number | null>;
    const statuses = ["OPEN", "MERGED", "CLOSED", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELED",
      "COMPLETED", "BACKLOG", "UNKNOWN"] as const;
    const byStatus = Object.fromEntries(statuses.map((status) => [
      status, projections.filter((item) => item.statusCategory === status).length,
    ])) as Record<WorkStatusCategory, number>;
    const output: WorkSystemCollectionOutput = {
      schemaVersion: "axtory.work-system-collection-output.v1",
      collectionRunId,
      provider: api.provider,
      coverage: enumeration.coverage,
      authentication: discovery.authentication,
      artifacts: {
        returned: projections.length, revisionsCreated, revisionsUnchanged, byKind, byStatus,
      },
      repositoryLinks: { matched: correlationRecords.length, derivation: "OBSERVED" },
      metrics: metricRecords.map((item) => ({
        key: item.key, value: item.value, unit: item.unit, derivation: item.derivation,
        availability: item.availability, reason: item.reason,
        evidenceCount: item.evidenceIds.length, evidenceStatus: item.evidenceStatus,
      })),
      limitations: [
        "Counts cover official API returned artifacts, not completed units of work or AI contribution.",
        "Titles, descriptions, comments, logs, user identities, URLs, and repository names are excluded.",
        "Commit relations are observed Vendor links; session-to-commit temporal correlations remain inferred.",
        "Repository links require an explicit Vendor commit identity present in the selected Local Git revision.",
        "A partial pagination result is never promoted to complete coverage.",
      ],
    };
    const payloadDigest = await writeJsonAtomically(options.jsonOutputPath, output);
    database.recordExport({
      id: `export_${randomId()}`, sink: "JSON_FILE", destination: options.jsonOutputPath,
      policyVersion: OUTPUT_POLICY_VERSION, recordCount: output.metrics.length,
      classifications: ["LOCAL_METADATA"], status: "COMPLETED", payloadDigest, exportedAt: timestamp(),
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

export function renderWorkSystemCollection(output: WorkSystemCollectionOutput): string {
  const lines = [
    `AXtory ${output.provider} work-system evidence`,
    `Coverage: ${output.coverage}`,
    `Artifacts returned: ${output.artifacts.returned}`,
    `Revisions created: ${output.artifacts.revisionsCreated}`,
    `Revisions unchanged: ${output.artifacts.revisionsUnchanged}`,
  ];
  for (const metric of output.metrics) {
    lines.push(metric.availability === "AVAILABLE" || metric.availability === "PARTIAL"
      ? `${metric.key}: ${String(metric.value)} ${metric.unit ?? ""} [${metric.availability}]`
      : `${metric.key}: unavailable [${metric.availability}] Reason: ${metric.reason ?? "unknown"}`);
  }
  return `${lines.join("\n").slice(0, 16_384)}\n`;
}
