import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { analyzeOtelFacts, OTEL_FACT_ANALYZER_VERSION } from "../analysis/otel-analyzer.js";
import { ContentAddressedBlobStore } from "../core/blob-store.js";
import { canonicalJson, stableId } from "../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../core/data-directory.js";
import { OUTPUT_POLICY_VERSION, writeJsonAtomically } from "../core/output.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "../core/policy.js";
import type { NormalizedObservation } from "../core/records.js";
import { AxtoryDatabase } from "../core/storage.js";
import { LIVE_NORMALIZER_VERSION, normalizeLiveEnvelope } from "./normalizer.js";
import { BoundedSpool } from "./spool.js";

export interface LiveIngestionSummary {
  schemaVersion: "axtory.live-ingestion-output.v1";
  collectionRunId: string;
  received: number;
  ingested: number;
  duplicates: number;
  failed: number;
  hookEvents: number;
  otelObservations: number;
  telemetryFacts: number;
  availability: {
    tokens: "AVAILABLE" | "NOT_COLLECTED";
    model: "AVAILABLE" | "NOT_COLLECTED";
    cost: "AVAILABLE" | "NOT_COLLECTED";
    latency: "AVAILABLE" | "NOT_COLLECTED";
  };
}

export async function ingestLiveSpool(options: {
  dataDirectory: string;
  jsonOutputPath: string;
  now?: () => Date;
  randomId?: () => string;
}): Promise<LiveIngestionSummary> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const timestamp = () => now().toISOString();
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const spool = new BoundedSpool(join(dataDirectory, "spool"));
  await spool.reconcileInterrupted(timestamp());
  const pending = await spool.listPending();
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const blobs = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
  const collectionRunId = `collection_${randomId()}`;
  database.reconcileInterruptedRuns(timestamp());
  database.saveCollectionPolicy(DEFAULT_LOCAL_COLLECTION_POLICY, timestamp());
  database.startCollectionRun(collectionRunId, "CLAUDE_LIVE", timestamp());
  let ingested = 0;
  let duplicates = 0;
  let failed = 0;
  const observations: NormalizedObservation[] = [];
  try {
    for (const envelope of pending) {
      await spool.transition(envelope.id, "PROCESSING", timestamp());
      try {
        const bytes = new TextEncoder().encode(canonicalJson(envelope.payload));
        const blob = await blobs.put(bytes);
        const sourceObjectId = stableId("source", { sourceType: envelope.channel, key: envelope.id });
        const revisionId = stableId("revision", { sourceObjectId, contentHash: blob.digest });
        let created = false;
        const normalized = normalizeLiveEnvelope(envelope, revisionId);
        database.transaction(() => {
          database.upsertSourceObject(sourceObjectId, envelope.channel, envelope.id);
          created = database.insertRevision({
            id: revisionId, sourceObjectId, contentHash: blob.digest, collectedAt: envelope.receivedAt,
            sourceModifiedAt: null, normalizerVersion: LIVE_NORMALIZER_VERSION, payloadReference: blob.relativePath,
          });
          if (created) {
            database.insertRawObservation({
              id: stableId("raw", { revisionId, type: "LIVE_EVENT" }), sourceRevisionId: revisionId,
              observationType: "LIVE_EVENT", provenance: "OFFICIAL_API",
              dataClassification: envelope.channel === "CLAUDE_HOOK" ? "TOOL_CONTENT" : "PERSONAL_DATA",
              payloadReference: blob.relativePath, observedAt: envelope.receivedAt, sourceModifiedAt: null,
            });
            database.insertObservations(normalized);
          }
          database.linkCollectionRevision(collectionRunId, sourceObjectId, revisionId, envelope.receivedAt);
        });
        if (created) {
          ingested += 1;
          observations.push(...normalized);
        } else {
          duplicates += 1;
        }
        await spool.transition(envelope.id, "COMPLETED", timestamp());
        await spool.discardCompleted(envelope.id);
      } catch (error) {
        failed += 1;
        await spool.transition(envelope.id, "FAILED", timestamp(),
          error instanceof Error ? error.message.slice(0, 256) : "UNKNOWN");
      }
    }
    const otel = observations.filter((item) => item.stableKey.startsWith("otel-"));
    let records = [] as ReturnType<typeof analyzeOtelFacts>;
    if (otel.length > 0) {
      const analysisRunId = `analysis_${randomId()}`;
      database.startAnalysisRun({
        id: analysisRunId, analyzerType: "OTEL_FACT_ANALYZER", analyzerVersion: OTEL_FACT_ANALYZER_VERSION,
        inputRevisionIds: [...new Set(otel.map((item) => item.sourceRevisionId))], startedAt: timestamp(),
      });
      records = analyzeOtelFacts(analysisRunId, otel);
      database.transaction(() => database.insertAnalysisRecords(records));
      database.finishAnalysisRun(analysisRunId, "COMPLETED", timestamp());
    }
    const serialized = JSON.stringify(records);
    const available = (pattern: RegExp) => pattern.test(serialized) ? "AVAILABLE" as const : "NOT_COLLECTED" as const;
    const summary: LiveIngestionSummary = {
      schemaVersion: "axtory.live-ingestion-output.v1", collectionRunId,
      received: pending.length, ingested, duplicates, failed,
      hookEvents: observations.filter((item) => item.stableKey === "hook-event").length,
      otelObservations: otel.length, telemetryFacts: records.length,
      availability: {
        tokens: available(/tokens|token\.usage/u),
        model: available(/model/u),
        cost: available(/cost/u),
        latency: available(/latency|duration_ms/u),
      },
    };
    const payloadDigest = await writeJsonAtomically(options.jsonOutputPath, summary);
    database.recordExport({
      id: `export_${randomId()}`, sink: "JSON_FILE", destination: options.jsonOutputPath,
      policyVersion: OUTPUT_POLICY_VERSION, recordCount: records.length,
      classifications: ["PUBLIC_METADATA"], status: "COMPLETED", payloadDigest, exportedAt: timestamp(),
    });
    // The run completed its pass over the spool. Envelopes that failed never produced a revision,
    // so the run stays COMPLETED and keeps the successfully ingested revisions eligible as heads;
    // failing the whole run would hide that evidence from every later report.
    database.finishCollectionRun(collectionRunId, "COMPLETED", timestamp(),
      failed === 0 ? undefined : "PARTIAL_INGESTION");
    return summary;
  } catch (error) {
    database.finishCollectionRun(collectionRunId, "FAILED", timestamp(), "INGESTION_ERROR");
    throw error;
  } finally {
    database.close();
  }
}
