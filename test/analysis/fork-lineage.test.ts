import test from "node:test";
import assert from "node:assert/strict";

import { detectForkLineage, forkPrefixLength, forkLineageInput } from "../../src/analysis/fork-lineage.js";
import type { ForkLineageInput } from "../../src/analysis/fork-lineage.js";
import type { NormalizedObservation } from "../../src/core/records.js";

function session(overrides: Partial<ForkLineageInput> & { revisionId: string }): ForkLineageInput {
  return {
    sessionObservationId: `obs_${overrides.revisionId}`,
    conversationIdentity: `conversation_${overrides.revisionId}`,
    createdAt: "2026-03-01T00:00:00.000Z",
    messageIdentities: [],
    identitiesAreVendorAssigned: true,
    ...overrides,
  };
}

test("a fork is the shared contiguous opening of both sessions", () => {
  // The shape observed in real history: the parent stopped at its first messages and the child,
  // created later, replays them and continues.
  assert.deepEqual(forkPrefixLength(["a", "b", "c"], ["a", "b", "c", "d", "e"]),
    { shared: 3, prefix: 3, ambiguous: false });
  // Both sessions continuing after the fork is still a fork; neither contains the other.
  assert.deepEqual(forkPrefixLength(["a", "b", "x"], ["a", "b", "y", "z"]),
    { shared: 2, prefix: 2, ambiguous: false });
});

test("shapes a fork cannot produce yield no relation", () => {
  // Nothing shared at all.
  assert.deepEqual(forkPrefixLength(["a"], ["b"]), { shared: 0, prefix: 0, ambiguous: false });
  // Shared in the middle but not from the opening: a copy cannot produce this.
  assert.equal(forkPrefixLength(["a", "b", "c"], ["z", "b", "c"]).ambiguous, true);
  // Shared opening plus an identity reappearing later: not a clean copy.
  assert.equal(forkPrefixLength(["a", "b", "q"], ["a", "c", "q"]).ambiguous, true);
});

test("the later session is the child and the relation is INFERRED", () => {
  const { records, summary } = detectForkLineage("analysis_run", [
    session({
      revisionId: "parent", createdAt: "2026-03-01T00:00:00.000Z",
      messageIdentities: ["a", "b"],
    }),
    session({
      revisionId: "child", createdAt: "2026-03-02T00:00:00.000Z",
      messageIdentities: ["a", "b", "c"],
    }),
  ]);
  assert.equal(records.length, 1);
  assert.equal(summary.relationsFound, 1);
  const record = records[0]!;
  assert.equal(record.recordType, "RELATION");
  assert.equal(record.derivation, "INFERRED", "Claude declares no parent, so this is not OBSERVED");
  assert.deepEqual(record.value, {
    relationType: "FORKED_FROM",
    childRevisionId: "child",
    parentRevisionId: "parent",
    childConversationIdentity: "conversation_child",
    parentConversationIdentity: "conversation_parent",
    sharedMessageCount: 2,
  });
  assert.deepEqual([...record.evidenceIds].sort(), ["obs_child", "obs_parent"]);
});

test("an ambiguous pair is counted but produces no relation", () => {
  const { records, summary } = detectForkLineage("analysis_run", [
    session({ revisionId: "one", createdAt: "2026-03-01T00:00:00.000Z", messageIdentities: ["a", "b"] }),
    session({ revisionId: "two", createdAt: "2026-03-02T00:00:00.000Z", messageIdentities: ["z", "b"] }),
  ]);
  assert.equal(records.length, 0);
  assert.equal(summary.candidatePairs, 1);
  assert.equal(summary.ambiguousPairs, 1);
});

test("a pair with no readable direction produces no relation", () => {
  // A fork relation without a direction is not a fork relation, so an unknown or tied creation
  // time yields nothing rather than an arbitrary parent.
  const { records, summary } = detectForkLineage("analysis_run", [
    session({ revisionId: "one", createdAt: null, messageIdentities: ["a", "b"] }),
    session({ revisionId: "two", createdAt: "2026-03-02T00:00:00.000Z", messageIdentities: ["a", "b", "c"] }),
  ]);
  assert.equal(records.length, 0);
  assert.equal(summary.undatedPairs, 1);
});

test("content-derived message identity disqualifies a session", () => {
  // Two sessions that merely opened with the same prompt would share a content-derived identity.
  // Treating that as lineage is exactly the false positive the predicate exists to prevent.
  const { records, summary } = detectForkLineage("analysis_run", [
    session({
      revisionId: "one", createdAt: "2026-03-01T00:00:00.000Z",
      messageIdentities: ["same-opening"], identitiesAreVendorAssigned: false,
    }),
    session({
      revisionId: "two", createdAt: "2026-03-02T00:00:00.000Z",
      messageIdentities: ["same-opening", "b"], identitiesAreVendorAssigned: false,
    }),
  ]);
  assert.equal(records.length, 0);
  assert.equal(summary.sessionsExcludedForContentFallback, 2);
  assert.equal(summary.candidatePairs, 0);
});

test("message order is recovered from the index, not from stable-key text", () => {
  // observationsForRevision orders by stable_key as text, which sorts message:10 before message:2.
  const base = {
    sourceRevisionId: "revision", derivation: "OBSERVED" as const, provenance: "OFFICIAL_API" as const,
    dataClassification: "CONVERSATION_CONTENT" as const, occurredAt: null,
    timeQuality: "ORDER_ONLY" as const, kind: "CONTENT" as const,
  };
  const observations: NormalizedObservation[] = [
    {
      ...base, id: "obs_session", stableKey: "session", kind: "SNAPSHOT",
      dataClassification: "LOCAL_METADATA", occurredAt: "2026-03-01T00:00:00.000Z",
      timeQuality: "SOURCE_REPORTED", payload: { sourceConversationIdentity: "conversation" },
    },
    ...[0, 1, 2, 10].map((index) => ({
      ...base, id: `obs_${index}`, stableKey: `message:${index}:identity-${index}`,
      payload: { sourceMessageIdentity: `identity-${index}`, sourceMessageIdentityFrom: "VENDOR_UUID" },
    })),
  ];
  const input = forkLineageInput("revision", observations);
  assert.deepEqual(input?.messageIdentities, ["identity-0", "identity-1", "identity-2", "identity-10"]);
  assert.equal(input?.identitiesAreVendorAssigned, true);
});

test("a revision predating the provenance field is still treated as Vendor-assigned", () => {
  // Measured across 14744 real messages: every one carried a uuid, so an unmarked revision is
  // treated as Vendor-assigned. Only an explicit fallback marker disqualifies a session.
  const input = forkLineageInput("revision", [
    {
      id: "obs_session", sourceRevisionId: "revision", stableKey: "session", kind: "SNAPSHOT",
      derivation: "OBSERVED", provenance: "OFFICIAL_API", dataClassification: "LOCAL_METADATA",
      occurredAt: "2026-03-01T00:00:00.000Z", timeQuality: "SOURCE_REPORTED",
      payload: { sourceConversationIdentity: "conversation" },
    },
    {
      id: "obs_0", sourceRevisionId: "revision", stableKey: "message:0:identity", kind: "CONTENT",
      derivation: "OBSERVED", provenance: "OFFICIAL_API", dataClassification: "CONVERSATION_CONTENT",
      occurredAt: null, timeQuality: "ORDER_ONLY",
      payload: { sourceMessageIdentity: "identity" },
    },
  ]);
  assert.equal(input?.identitiesAreVendorAssigned, true);
});
