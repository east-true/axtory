import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { analyzeFacts, FACT_ANALYZER_VERSION } from "../analysis/fact-analyzer.js";
import { projectSession } from "../projections/session.js";
import {
  FIXTURE_NORMALIZER_VERSION,
  normalizeClaudeHistoryFixture,
  parseClaudeHistoryFixture,
} from "../fixtures/claude-history.js";
import { ContentAddressedBlobStore } from "./blob-store.js";
import { stableId } from "./canonical-json.js";
import { ensureAxtoryDataDirectory } from "./data-directory.js";
import { applyOutputPolicy, OUTPUT_POLICY_VERSION, type SkeletonOutput, writeJsonAtomically } from "./output.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "./policy.js";
import { AxtoryDatabase } from "./storage.js";

export interface WalkingSkeletonOptions {
  fixturePath: string;
  dataDirectory: string;
  jsonOutputPath: string;
  now?: () => Date;
  randomId?: () => string;
}

export interface WalkingSkeletonResult {
  output: SkeletonOutput;
  databasePath: string;
}

export async function runWalkingSkeleton(options: WalkingSkeletonOptions): Promise<WalkingSkeletonResult> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const timestamp = () => now().toISOString();
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const databasePath = join(dataDirectory, "axtory.sqlite3");
  const database = new AxtoryDatabase(databasePath);
  const collectionRunId = `collection_${randomId()}`;
  database.reconcileInterruptedRuns(timestamp());
  database.saveCollectionPolicy(DEFAULT_LOCAL_COLLECTION_POLICY, timestamp());
  database.startCollectionRun(collectionRunId, "FIXTURE", timestamp());
  try {
    const fixtureStat = await stat(options.fixturePath);
    if (fixtureStat.size > 16 * 1024 * 1024) {
      throw new Error("fixture exceeds the 16 MiB walking-skeleton input limit");
    }
    const bytes = await readFile(options.fixturePath);
    const fixture = parseClaudeHistoryFixture(bytes);
    const blob = await new ContentAddressedBlobStore(join(dataDirectory, "blobs")).put(bytes);
    const sourceObjectId = stableId("source", { sourceType: "FIXTURE", key: fixture.sourceObjectKey });
    const revisionId = stableId("revision", { sourceObjectId, contentHash: blob.digest });
    database.upsertSourceObject(sourceObjectId, "FIXTURE", fixture.sourceObjectKey);
    const revisionCreated = database.insertRevision({
      id: revisionId,
      sourceObjectId,
      contentHash: blob.digest,
      collectedAt: timestamp(),
      sourceModifiedAt: fixture.sourceModifiedAt ?? null,
      normalizerVersion: FIXTURE_NORMALIZER_VERSION,
      payloadReference: blob.relativePath,
    });
    database.transaction(() => {
      database.insertRawObservation({
        id: stableId("raw", { revisionId, type: "FIXTURE_DOCUMENT" }),
        sourceRevisionId: revisionId,
        observationType: "FIXTURE_DOCUMENT",
        provenance: "LOCAL_FILE",
        dataClassification: "CONVERSATION_CONTENT",
        payloadReference: blob.relativePath,
        observedAt: timestamp(),
        sourceModifiedAt: fixture.sourceModifiedAt ?? null,
      });
      database.insertObservations(normalizeClaudeHistoryFixture(fixture, revisionId));
      database.linkCollectionRevision(collectionRunId, sourceObjectId, revisionId, timestamp());
    });
    const observations = database.observationsForRevision(revisionId);
    const sessionProjection = projectSession(observations);
    const analysisRunId = `analysis_${randomId()}`;
    database.startAnalysisRun({
      id: analysisRunId,
      analyzerType: "FACT_ANALYZER",
      analyzerVersion: FACT_ANALYZER_VERSION,
      inputRevisionIds: [revisionId],
      startedAt: timestamp(),
    });
    const records = analyzeFacts(analysisRunId, [sessionProjection]);
    database.transaction(() => database.insertAnalysisRecords(records));
    database.finishAnalysisRun(analysisRunId, "COMPLETED", timestamp());
    const output = applyOutputPolicy(collectionRunId, revisionId, revisionCreated, records);
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
    return { output, databasePath };
  } catch (error) {
    database.finishCollectionRun(collectionRunId, "FAILED", timestamp(), "COLLECTION_ERROR");
    throw error;
  } finally {
    database.close();
  }
}
