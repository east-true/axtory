import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { generateUsageReport } from "../../src/analysis/usage-report.js";
import { stableId } from "../../src/core/canonical-json.js";
import type { NormalizedObservation } from "../../src/core/records.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

test("usage report selects only the latest revision and preserves bounded-time uncertainty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-report-"));
  try {
    await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "fixture.json"),
      now: () => new Date("2026-01-02T04:00:00.000Z"), randomId: () => "fixture-run",
    });
    const sourceObjectId = stableId("source", { sourceType: "FIXTURE", key: "synthetic-normal-session" });
    const revisionId = "revision_latest_usage";
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      database.insertRevision({
        id: revisionId, sourceObjectId, contentHash: "f".repeat(64),
        collectedAt: "2026-02-02T00:00:00.000Z", sourceModifiedAt: "2026-02-01T01:00:00.000Z",
        normalizerVersion: "usage-test/1", payloadReference: "blobs/not-retained",
      });
      database.startCollectionRun("collection_latest_usage", "FIXTURE", "2026-02-02T00:00:00.000Z");
      database.linkCollectionRevision(
        "collection_latest_usage", sourceObjectId, revisionId, "2026-02-02T00:00:00.000Z",
      );
      database.finishCollectionRun("collection_latest_usage", "COMPLETED", "2026-02-02T00:01:00.000Z");
      const base = {
        sourceRevisionId: revisionId, derivation: "OBSERVED" as const, provenance: "LOCAL_FILE" as const,
        dataClassification: "LOCAL_METADATA" as const,
      };
      const observations: NormalizedObservation[] = [
        { ...base, id: "obs_session", stableKey: "session", kind: "SNAPSHOT",
          occurredAt: "2026-02-01T00:00:00.000Z", timeQuality: "SOURCE_REPORTED",
          payload: { messageCoverage: "PARTIAL_COMPACTION" } },
        { ...base, id: "obs_user", stableKey: "message:1", kind: "CONTENT",
          occurredAt: "2026-02-01T00:01:00.000Z", timeQuality: "SOURCE_REPORTED",
          payload: { role: "user" } },
        { ...base, id: "obs_assistant", stableKey: "message:2", kind: "CONTENT",
          occurredAt: "2026-02-01T00:02:00.000Z", timeQuality: "SOURCE_REPORTED",
          payload: { role: "assistant" } },
        { ...base, id: "obs_tool_safe", stableKey: "tool-occurrence:1", kind: "EVENT",
          occurredAt: "2026-02-01T00:03:00.000Z", timeQuality: "SOURCE_REPORTED",
          payload: { toolName: "Write" } },
        { ...base, id: "obs_tool_private", stableKey: "tool-occurrence:2", kind: "EVENT",
          occurredAt: null, timeQuality: "UNKNOWN",
          payload: { toolName: "mcp:PRIVATE-CUSTOM-SERVER" } },
      ];
      database.insertObservations(observations);
    } finally {
      database.close();
    }
    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      since: "2026-02-01T00:00:00.000Z", until: "2026-02-02T00:00:00.000Z",
      now: () => new Date("2026-02-03T00:00:00.000Z"), randomId: () => `usage-${++sequence}`,
    });
    assert.equal(report.totals.sessions, 1);
    assert.equal(report.totals.messages, 2);
    assert.equal(report.totals.userMessages, 1);
    assert.equal(report.totals.assistantMessages, 1);
    assert.equal(report.totals.toolInvocations, 1);
    assert.equal(report.totals.availability, "PARTIAL");
    assert.equal(report.coverage.excludedUndatedObservations, 1);
    assert.equal(report.coverage.completedCollectionHeads, 1);
    assert.equal(report.coverage.legacyFallbackHeads, 0);
    assert.deepEqual(report.toolCategories, [{ category: "file-change", count: 1, percentage: 100 }]);
    assert.equal(report.sessionDistribution.messagesPerSession.median, 2);
    assert.equal(report.patterns.activeUtcDays, 1);
    assert.equal(report.patterns.sessionsWithToolsPercentage, 100);
    assert.equal(report.patterns.assistantMessagesPerUserMessage, 1);
    assert.equal(report.patterns.toolInvocationsPerAssistantMessage, 1);
    assert.equal(report.semantics.availability, "NOT_RETAINED");
    const output = await readFile(join(directory, "usage.json"), "utf8");
    assert.equal(output.includes("PRIVATE-CUSTOM-SERVER"), false);
    assert.equal(output.includes(sourceObjectId), false);
    const verifier = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.equal(verifier.completedAnalysisForExactInputs(
        "USAGE_REPORT_ANALYZER", "usage-report/1", [revisionId],
      )?.records.length, 8);
      assert.equal(verifier.count("export_runs"), 2);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage report runs and integrates opt-in semantics for current retained revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-semantics-"));
  try {
    await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "fixture.json"),
      now: () => new Date("2026-01-02T04:00:00.000Z"), randomId: () => "semantic-fixture",
    });
    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      allowConversationContent: true,
      now: () => new Date("2026-02-03T00:00:00.000Z"), randomId: () => `semantic-${++sequence}`,
    });
    assert.equal(report.semantics.availability, "AVAILABLE");
    assert.equal(report.semantics.candidateRevisions, 1);
    assert.equal(report.semantics.eligibleRevisions, 1);
    assert.equal(report.semantics.analyzedRevisions, 1);
    assert.equal(report.semantics.assertions, 1);
    assert.deepEqual(report.semantics.categories, [{ category: "CHANGE_COMPLETED", count: 1 }]);
    assert.equal((await readFile(join(directory, "usage.json"), "utf8")).includes("synthetic artifact"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage report does not turn an unavailable source or invalid time range into zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-unavailable-"));
  try {
    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"), sourceTypes: ["CODEX"],
      now: () => new Date("2026-02-03T00:00:00.000Z"), randomId: () => `empty-${++sequence}`,
    });
    assert.equal(report.totals.availability, "SOURCE_UNAVAILABLE");
    assert.equal(report.totals.sessions, null);
    assert.equal(report.totals.messages, null);
    assert.equal(report.totals.toolInvocations, null);
    await assert.rejects(() => generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "invalid.json"),
      since: "2026-02-04T00:00:00Z", until: "2026-02-03T00:00:00Z",
    }), /--since must be earlier/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
