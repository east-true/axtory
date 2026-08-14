import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { correlateGitWithSession, GIT_CORRELATION_VERSION } from "../../analysis/git-correlation.js";
import { ContentAddressedBlobStore } from "../../core/blob-store.js";
import { canonicalJson, stableId } from "../../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../../core/data-directory.js";
import { OUTPUT_POLICY_VERSION, writeJsonAtomically } from "../../core/output.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "../../core/policy.js";
import { persistCollectedRevision } from "../../core/revision-persistence.js";
import { AxtoryDatabase } from "../../core/storage.js";
import { readLocalGitSnapshot, type GitCommandRunner } from "./local-git.js";
import { GIT_NORMALIZER_VERSION, normalizeLocalGitSnapshot } from "./normalizer.js";

export interface GitCollectionOutput {
  schemaVersion: "axtory.git-collection-output.v1";
  collectionRunId: string;
  sourceRevisionId: string;
  revisionCreated: boolean;
  commitsReturned: number;
  dirty: boolean;
  correlations: number;
  correlationDerivation: "INFERRED";
  limitations: readonly string[];
}

export async function collectLocalGit(options: {
  repositoryDirectory: string;
  dataDirectory: string;
  jsonOutputPath: string;
  sessionRevisionId?: string;
  maximumCommits?: number;
  runner?: GitCommandRunner;
  now?: () => Date;
  randomId?: () => string;
}): Promise<GitCollectionOutput> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const timestamp = () => now().toISOString();
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const collectionRunId = `collection_${randomId()}`;
  database.reconcileInterruptedRuns(timestamp());
  database.saveCollectionPolicy(DEFAULT_LOCAL_COLLECTION_POLICY, timestamp());
  database.startCollectionRun(collectionRunId, "LOCAL_GIT", timestamp());
  try {
    const snapshot = await readLocalGitSnapshot({
      repositoryDirectory: options.repositoryDirectory,
      ...(options.maximumCommits ? { maximumCommits: options.maximumCommits } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
    });
    const bytes = new TextEncoder().encode(canonicalJson(snapshot));
    const blob = await new ContentAddressedBlobStore(join(dataDirectory, "blobs")).put(bytes);
    const sourceObjectId = stableId("source", { sourceType: "LOCAL_GIT", key: snapshot.repositoryIdentity });
    const revisionId = stableId("revision", { sourceObjectId, contentHash: blob.digest });
    const persistedAt = timestamp();
    const { created: revisionCreated } = await persistCollectedRevision(database, {
      dataDirectory,
      collectionRunId,
      sourceObject: { id: sourceObjectId, sourceType: "LOCAL_GIT", externalKey: snapshot.repositoryIdentity },
      revision: {
        id: revisionId, sourceObjectId, contentHash: blob.digest, collectedAt: persistedAt,
        sourceModifiedAt: null, normalizerVersion: GIT_NORMALIZER_VERSION, payloadReference: blob.relativePath,
      },
      rawObservation: {
        id: stableId("raw", { revisionId, type: "GIT_SNAPSHOT" }), sourceRevisionId: revisionId,
        observationType: "GIT_SNAPSHOT", provenance: "LOCAL_FILE", dataClassification: "LOCAL_METADATA",
        payloadReference: blob.relativePath, observedAt: persistedAt, sourceModifiedAt: null,
      },
      observations: normalizeLocalGitSnapshot(snapshot, revisionId),
      observedAt: persistedAt,
    });
    let correlations = 0;
    if (options.sessionRevisionId) {
      const sessionObservations = database.observationsForRevision(options.sessionRevisionId);
      if (sessionObservations.length === 0) throw new Error("session revision for Git correlation does not exist");
      const analysisRunId = `analysis_${randomId()}`;
      database.startAnalysisRun({
        id: analysisRunId, analyzerType: "GIT_CORRELATION", analyzerVersion: GIT_CORRELATION_VERSION,
        inputRevisionIds: [options.sessionRevisionId, revisionId], startedAt: timestamp(),
      });
      const records = correlateGitWithSession(
        analysisRunId, sessionObservations, database.observationsForRevision(revisionId),
      );
      database.transaction(() => database.insertAnalysisRecords(records));
      database.finishAnalysisRun(analysisRunId, "COMPLETED", timestamp());
      correlations = records.length;
    }
    const output: GitCollectionOutput = {
      schemaVersion: "axtory.git-collection-output.v1", collectionRunId,
      sourceRevisionId: revisionId, revisionCreated, commitsReturned: snapshot.commits.length,
      dirty: snapshot.dirty, correlations, correlationDerivation: "INFERRED",
      limitations: [
        "Commit metadata excludes messages, author identities, file paths, and diff content.",
        "Temporal correlation does not establish that an agent or session authored a commit.",
      ],
    };
    const payloadDigest = await writeJsonAtomically(options.jsonOutputPath, output);
    database.recordExport({
      id: `export_${randomId()}`, sink: "JSON_FILE", destination: options.jsonOutputPath,
      policyVersion: OUTPUT_POLICY_VERSION, recordCount: correlations,
      classifications: ["PUBLIC_METADATA"], status: "COMPLETED", payloadDigest, exportedAt: timestamp(),
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
