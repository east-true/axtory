import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { stableId } from "../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../core/data-directory.js";
import type { AnalysisRecord, NormalizedObservation } from "../core/records.js";
import { AxtoryDatabase } from "../core/storage.js";

export const FORK_LINEAGE_ANALYZER_VERSION = "shared-message-identity/1";

/**
 * One session reduced to what the fork predicate needs: ordered Vendor message identities and the
 * time the session was created. No content, no path, no session id — only digests.
 */
export interface ForkLineageInput {
  revisionId: string;
  sessionObservationId: string;
  conversationIdentity: string;
  createdAt: string | null;
  /** Message identity digests in source order. */
  messageIdentities: readonly string[];
  /** False when any message identity was derived from content rather than a Vendor uuid. */
  identitiesAreVendorAssigned: boolean;
}

export interface ForkLineageSummary {
  analysisRunId: string;
  derivation: "INFERRED";
  sessionsConsidered: number;
  sessionsExcludedForContentFallback: number;
  candidatePairs: number;
  relationsFound: number;
  ambiguousPairs: number;
  undatedPairs: number;
  limitation: string;
}

const LIMITATION =
  "A fork is inferred from Vendor-assigned message identity, not from a declared field. " +
  "Claude states no parent, so this relation is INFERRED and can disappear if the Vendor " +
  "stops preserving message ids across a fork.";

function longestCommonPrefix(left: readonly string[], right: readonly string[]): number {
  const bound = Math.min(left.length, right.length);
  let index = 0;
  while (index < bound && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Decide fork lineage between two sessions that share at least one message identity.
 *
 * A fork copies the parent's messages from the beginning, keeping their ids, so the shared
 * identities must be a contiguous prefix of *both* sessions. Requiring that rejects the shapes a
 * fork cannot produce — identities shared in the middle, or shared out of order — instead of
 * guessing at them. Either session may have grown after the fork, so neither has to contain the
 * other; only the common opening has to match.
 */
export function forkPrefixLength(
  left: readonly string[],
  right: readonly string[],
): { shared: number; prefix: number; ambiguous: boolean } {
  const rightIdentities = new Set(right);
  const shared = new Set(left.filter((identity) => rightIdentities.has(identity)));
  if (shared.size === 0) return { shared: 0, prefix: 0, ambiguous: false };
  const prefix = longestCommonPrefix(left, right);
  // The common opening already accounts for `prefix` shared identities. If the two sessions share
  // more than that, something is shared outside the copied opening, which a fork cannot produce —
  // so no relation is emitted rather than one being guessed at. A shared identity with no common
  // opening at all (prefix 0) is caught by the same test.
  return { shared: shared.size, prefix, ambiguous: shared.size !== prefix };
}

export function detectForkLineage(
  analysisRunId: string,
  sessions: readonly ForkLineageInput[],
): { records: AnalysisRecord[]; summary: Omit<ForkLineageSummary, "analysisRunId" | "derivation" | "limitation"> } {
  const eligible = sessions.filter((session) =>
    session.identitiesAreVendorAssigned && session.messageIdentities.length > 0);
  const excluded = sessions.filter((session) => !session.identitiesAreVendorAssigned).length;

  const records: AnalysisRecord[] = [];
  let candidatePairs = 0;
  let ambiguousPairs = 0;
  let undatedPairs = 0;

  for (let a = 0; a < eligible.length; a += 1) {
    for (let b = a + 1; b < eligible.length; b += 1) {
      const left = eligible[a]!;
      const right = eligible[b]!;
      const { shared, prefix, ambiguous } = forkPrefixLength(left.messageIdentities, right.messageIdentities);
      if (shared === 0) continue;
      candidatePairs += 1;
      if (ambiguous) {
        ambiguousPairs += 1;
        continue;
      }
      // The child is the session created later. Without both timestamps the direction cannot be
      // read, and a fork relation without a direction is not a fork relation.
      if (!left.createdAt || !right.createdAt || left.createdAt === right.createdAt) {
        undatedPairs += 1;
        continue;
      }
      const [parent, child] = left.createdAt < right.createdAt ? [left, right] : [right, left];
      const key = `relation.fork.${child.revisionId}.${parent.revisionId}`;
      records.push({
        id: stableId("analysis", { analysisRunId, key }),
        analysisRunId,
        key,
        recordType: "RELATION",
        derivation: "INFERRED",
        value: {
          relationType: "FORKED_FROM",
          childRevisionId: child.revisionId,
          parentRevisionId: parent.revisionId,
          childConversationIdentity: child.conversationIdentity,
          parentConversationIdentity: parent.conversationIdentity,
          sharedMessageCount: prefix,
        },
        unit: null,
        availability: "AVAILABLE",
        reason: `The two sessions share the same ${prefix} Vendor-assigned message identities as a ` +
          "contiguous opening, and the child was created later. Claude declares no parent, so this " +
          "relation is inferred from identity rather than read from a field.",
        evidenceIds: [child.sessionObservationId, parent.sessionObservationId],
        evidenceStatus: "PRESENT",
      });
    }
  }

  return {
    records,
    summary: {
      sessionsConsidered: eligible.length,
      sessionsExcludedForContentFallback: excluded,
      candidatePairs,
      relationsFound: records.length,
      ambiguousPairs,
      undatedPairs,
    },
  };
}

function messageIndex(stableKey: string): number {
  const parts = stableKey.split(":");
  const parsed = Number(parts[1]);
  return Number.isInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

export function forkLineageInput(
  revisionId: string,
  observations: readonly NormalizedObservation[],
): ForkLineageInput | null {
  const session = observations.find((item) => item.stableKey === "session" && item.kind === "SNAPSHOT");
  if (!session) return null;
  const conversationIdentity = session.payload.sourceConversationIdentity;
  if (typeof conversationIdentity !== "string") return null;
  const messages = observations
    .filter((item) => item.kind === "CONTENT" && item.stableKey.startsWith("message:"))
    // observationsForRevision orders by stable_key as text, which puts message:10 before message:2,
    // so the source order has to be recovered from the index rather than taken from the query.
    .sort((left, right) => messageIndex(left.stableKey) - messageIndex(right.stableKey));
  const identities: string[] = [];
  let vendorAssigned = true;
  for (const message of messages) {
    const identity = message.payload.sourceMessageIdentity;
    if (typeof identity !== "string") return null;
    // Revisions collected before the provenance field existed carry no marker. They were measured
    // to hold a Vendor uuid on every message, so they are treated as Vendor-assigned; only an
    // explicit fallback marker disqualifies a session.
    if (message.payload.sourceMessageIdentityFrom === "CONTENT_FALLBACK") vendorAssigned = false;
    identities.push(identity);
  }
  return {
    revisionId,
    sessionObservationId: session.id,
    conversationIdentity,
    createdAt: session.occurredAt,
    messageIdentities: identities,
    identitiesAreVendorAssigned: vendorAssigned,
  };
}

export async function runForkLineageAnalysis(options: {
  dataDirectory: string;
  now?: () => Date;
  randomId?: () => string;
}): Promise<ForkLineageSummary> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const analysisRunId = `analysis_${randomId()}`;
  let started = false;
  try {
    const inputs = database.latestRevisions()
      .filter((revision) => revision.sourceType === "CLAUDE_CODE")
      .flatMap((revision) => {
        const input = forkLineageInput(revision.revisionId, database.observationsForRevision(revision.revisionId));
        return input ? [input] : [];
      });
    database.startAnalysisRun({
      id: analysisRunId,
      analyzerType: "FORK_LINEAGE_ANALYZER",
      analyzerVersion: FORK_LINEAGE_ANALYZER_VERSION,
      inputRevisionIds: inputs.map((input) => input.revisionId),
      startedAt: now().toISOString(),
    });
    started = true;
    const { records, summary } = detectForkLineage(analysisRunId, inputs);
    database.transaction(() => database.insertAnalysisRecords(records));
    database.finishAnalysisRun(analysisRunId, "COMPLETED", now().toISOString());
    return { analysisRunId, derivation: "INFERRED", ...summary, limitation: LIMITATION };
  } catch (error) {
    if (started) database.finishAnalysisRun(analysisRunId, "FAILED", now().toISOString(), "ANALYSIS_ERROR");
    throw error;
  } finally {
    database.close();
  }
}

export function renderForkLineage(summary: ForkLineageSummary): string {
  return [
    "AXtory Claude fork lineage",
    `Sessions considered: ${summary.sessionsConsidered}` +
      (summary.sessionsExcludedForContentFallback === 0
        ? ""
        : `, ${summary.sessionsExcludedForContentFallback} excluded for content-derived identity`),
    `Relations found: ${summary.relationsFound} [INFERRED] from ${summary.candidatePairs} candidate pairs`,
    `Not emitted: ${summary.ambiguousPairs} ambiguous, ${summary.undatedPairs} without a readable direction`,
    `Limitation: ${summary.limitation}`,
    "",
  ].join("\n");
}
