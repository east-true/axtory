import { join } from "node:path";

import type { ClaudeSessionInfo, ClaudeSessionMessage } from "../connectors/claude/history-api.js";
import { CLAUDE_NORMALIZER_VERSION, normalizeClaudeSession } from "../connectors/claude/normalizer.js";
import { CODEX_NORMALIZER_VERSION, normalizeCodexThread } from "../connectors/codex/normalizer.js";
import type { CodexMessageCoverage } from "../connectors/codex/normalizer.js";
import type { CodexThread } from "../connectors/codex/types.js";

type ClaudeCoverage = "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION" | "PARTIAL_SOURCE_CHANGED";

const CLAUDE_COVERAGES: readonly ClaudeCoverage[] =
  ["COMPLETE_FOR_RETURNED_VIEW", "PARTIAL_PAGINATION", "PARTIAL_SOURCE_CHANGED"];

const CODEX_COVERAGES: readonly CodexMessageCoverage[] = [
  "COMPLETE_FOR_RETURNED_VIEW", "PARTIAL_PAGINATION", "PARTIAL_COMPACTION",
  "PARTIAL_SOURCE_CHANGED", "PARTIAL_UNSETTLED_TURN",
];
import { ContentAddressedBlobStore } from "./blob-store.js";
import { ensureAxtoryDataDirectory } from "./data-directory.js";
import type { NormalizedObservation } from "./records.js";
import { AxtoryDatabase } from "./storage.js";

const RAW_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Re-normalization recomputes derived observations in place; it does not mint a revision.
 *
 * A SourceRevision is identified by the content hash of the raw view, so it stands for a state of
 * the source. The source did not change when the normalizer did, and minting a revision would both
 * claim otherwise and collide with the uniqueness the model rests on. Raw immutability means the
 * original is never modified, which recomputing a derived layer does not violate.
 */
export const RENORMALIZE_VERSION = "derived-observation-recompute/1";

export interface RenormalizeSummary {
  revisionsScanned: number;
  revisionsAlreadyCurrent: number;
  revisionsRenormalized: number;
  observationsReplaced: number;
  analysisRecordsInvalidated: number;
  /** Revisions that need re-normalization but cannot be recomputed, with the reason. */
  unsupported: readonly { sourceType: string; revisions: number; reason: string }[];
  rawEvidenceUnavailable: number;
}

/** Normalizers whose raw view holds a complete input, so the pass can reproduce their output. */
const CURRENT_VERSION: Readonly<Record<string, string>> = {
  VENDOR_SESSION_VIEW: CLAUDE_NORMALIZER_VERSION,
  CODEX_THREAD_VIEW: CODEX_NORMALIZER_VERSION,
};

/**
 * Raw views that do not carry what their normalizer consumed.
 *
 * The additional-AI collector stores the Vendor payload, not the parsed view its normalizer reads,
 * and reconstructing that view means re-running per-provider parsing that only exists behind a live
 * source adapter. Reporting the gap is the honest answer; silently skipping would let a stale
 * normalization look current.
 */
const UNSUPPORTED_REASON: Readonly<Record<string, string>> = {
  ADDITIONAL_AI_VIEW:
    "The stored raw view holds the Vendor payload rather than the parsed session the normalizer " +
    "reads, so the input cannot be reconstructed without a live source adapter. Recollect instead.",
  WORK_SYSTEM_VIEW:
    "Work-system re-normalization is not implemented; the artifact normalizer has not changed.",
  GIT_SNAPSHOT:
    "Local Git re-normalization is not implemented; the snapshot normalizer has not changed.",
  FIXTURE_DOCUMENT:
    "Fixture revisions are reproduced by re-running the fixture, not by re-normalizing.",
};

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("raw view is not a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * Recover the coverage the collector recorded for this view.
 *
 * Coverage describes the read that produced the view — whether pages were missed, whether the
 * source changed underneath, whether a turn had not settled — not the content being re-normalized.
 * Recomputing it now would be inventing a judgement about a read that already happened, so the
 * stored one is carried forward.
 */
function storedCoverage(observations: readonly NormalizedObservation[]): string | null {
  const session = observations.find((item) => item.stableKey === "session" && item.kind === "SNAPSHOT");
  const coverage = session?.payload.messageCoverage;
  return typeof coverage === "string" ? coverage : null;
}

function renormalizeObservations(
  observationType: string,
  payload: unknown,
  revisionId: string,
  coverage: string | null,
): NormalizedObservation[] {
  const view = record(payload);
  if (observationType === "VENDOR_SESSION_VIEW") {
    // An unrecognized stored coverage is not silently downgraded to complete: falling back to the
    // most optimistic value would turn a lost partial marker into a completeness claim.
    const value = CLAUDE_COVERAGES.find((item) => item === coverage);
    if (coverage !== null && value === undefined) {
      throw new Error(`stored coverage ${coverage} is not a Claude coverage value`);
    }
    return normalizeClaudeSession(
      record(view.session) as unknown as ClaudeSessionInfo,
      (Array.isArray(view.messages) ? view.messages : []) as ClaudeSessionMessage[],
      revisionId,
      value ?? "PARTIAL_SOURCE_CHANGED",
    );
  }
  if (observationType === "CODEX_THREAD_VIEW") {
    const value = CODEX_COVERAGES.find((item) => item === coverage);
    if (coverage !== null && value === undefined) {
      throw new Error(`stored coverage ${coverage} is not a Codex coverage value`);
    }
    return normalizeCodexThread(
      record(view.thread) as unknown as CodexThread,
      revisionId,
      value ?? "PARTIAL_SOURCE_CHANGED",
    );
  }
  throw new Error(`re-normalization is not supported for ${observationType}`);
}

export async function renormalizeStoredRevisions(options: {
  dataDirectory: string;
  dryRun?: boolean;
}): Promise<RenormalizeSummary> {
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const blobs = new ContentAddressedBlobStore(join(dataDirectory, "blobs"));
  try {
    const revisions = database.revisionsWithNormalizerVersion();
    const unsupported = new Map<string, { sourceType: string; revisions: number; reason: string }>();
    const renormalizedRevisionIds: string[] = [];
    let alreadyCurrent = 0;
    let observationsReplaced = 0;
    let rawEvidenceUnavailable = 0;

    for (const revision of revisions) {
      const raw = database.rawObservationForRevision(revision.revisionId);
      if (!raw) {
        // Raw evidence was deleted by policy or retention. The derived observations are all that is
        // left of this revision, so they are kept as they are rather than dropped.
        rawEvidenceUnavailable += 1;
        continue;
      }
      const current = CURRENT_VERSION[raw.observationType];
      if (current === undefined) {
        const reason = UNSUPPORTED_REASON[raw.observationType] ??
          `Re-normalization is not implemented for ${raw.observationType}.`;
        const key = `${revision.sourceType}:${raw.observationType}`;
        const entry = unsupported.get(key);
        if (entry) entry.revisions += 1;
        else unsupported.set(key, { sourceType: revision.sourceType, revisions: 1, reason });
        continue;
      }
      if (revision.normalizerVersion === current) {
        alreadyCurrent += 1;
        continue;
      }
      if (options.dryRun) {
        renormalizedRevisionIds.push(revision.revisionId);
        continue;
      }
      const bytes = await blobs.read(raw.payloadReference, RAW_LIMIT_BYTES);
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes));
      } catch (error) {
        throw new Error(`raw view for ${revision.revisionId} is not valid JSON`, { cause: error });
      }
      const existing = database.observationsForRevision(revision.revisionId);
      const observations = renormalizeObservations(
        raw.observationType, payload, revision.revisionId, storedCoverage(existing),
      );
      const result = database.replaceObservations(revision.revisionId, observations, current);
      observationsReplaced += result.inserted;
      renormalizedRevisionIds.push(revision.revisionId);
    }

    const analysisRecordsInvalidated = options.dryRun
      ? 0
      : database.markEvidenceInvalidatedForRevisionIds(renormalizedRevisionIds);

    return {
      revisionsScanned: revisions.length,
      revisionsAlreadyCurrent: alreadyCurrent,
      revisionsRenormalized: renormalizedRevisionIds.length,
      observationsReplaced,
      analysisRecordsInvalidated,
      unsupported: [...unsupported.values()],
      rawEvidenceUnavailable,
    };
  } finally {
    database.close();
  }
}

export function renderRenormalize(summary: RenormalizeSummary, dryRun: boolean): string {
  return [
    `AXtory re-normalization${dryRun ? " (dry run)" : ""}`,
    `Revisions scanned: ${summary.revisionsScanned}`,
    `${dryRun ? "Would re-normalize" : "Re-normalized"}: ${summary.revisionsRenormalized}` +
      (dryRun ? "" : `, replacing ${summary.observationsReplaced} observations`),
    `Already current: ${summary.revisionsAlreadyCurrent}`,
    ...(summary.rawEvidenceUnavailable === 0
      ? []
      : [`Raw evidence unavailable: ${summary.rawEvidenceUnavailable} (derived observations kept as they are)`]),
    ...(dryRun
      ? []
      : [`Analysis records invalidated: ${summary.analysisRecordsInvalidated}`]),
    ...summary.unsupported.map((item) =>
      `Unsupported: ${item.sourceType}, ${item.revisions} revisions. ${item.reason}`),
    "",
  ].join("\n");
}
