import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { generateUsageReport } from "../../src/analysis/usage-report.js";
import { ContentAddressedBlobStore } from "../../src/core/blob-store.js";
import { stableId } from "../../src/core/canonical-json.js";
import { executeSelectiveDeletion } from "../../src/core/deletion.js";
import type { NormalizedObservation } from "../../src/core/records.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { AxtoryDatabase } from "../../src/core/storage.js";
import { ingestLiveSpool } from "../../src/live/ingestion.js";
import { BoundedSpool } from "../../src/live/spool.js";

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
        "USAGE_REPORT_ANALYZER", "usage-report/2", [revisionId],
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

test("usage report suggests non-overlapping windows when the semantic revision limit is exceeded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-limit-"));
  try {
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    const blob = await new ContentAddressedBlobStore(join(directory, "blobs")).put(new TextEncoder().encode(
      JSON.stringify({ session: { messages: [{ role: "assistant", blocks: [{ type: "text", text: "fixed it" }] }] } }),
    ));
    const total = 150;
    const baseMs = Date.parse("2026-03-01T00:00:00.000Z");
    try {
      database.startCollectionRun("collection_limit", "FIXTURE", "2026-03-01T00:00:00.000Z");
      database.transaction(() => {
        for (let index = 0; index < total; index += 1) {
          const sourceObjectId = `source_limit_${index}`;
          const revisionId = `revision_limit_${index}`;
          const occurredAt = new Date(baseMs + index * 3_600_000).toISOString();
          database.upsertSourceObject(sourceObjectId, "FIXTURE", `limit-session-${index}`);
          database.insertRevision({
            id: revisionId, sourceObjectId, contentHash: index.toString(16).padStart(64, "0"),
            collectedAt: occurredAt, sourceModifiedAt: occurredAt,
            normalizerVersion: "usage-limit-test/1", payloadReference: blob.relativePath,
          });
          database.linkCollectionRevision("collection_limit", sourceObjectId, revisionId, occurredAt);
          const base = {
            sourceRevisionId: revisionId, derivation: "OBSERVED" as const, provenance: "LOCAL_FILE" as const,
            dataClassification: "LOCAL_METADATA" as const, occurredAt, timeQuality: "SOURCE_REPORTED" as const,
          };
          database.insertObservations([
            { ...base, id: `obs_session_${index}`, stableKey: "session", kind: "SNAPSHOT",
              payload: { messageCoverage: "FULL" } },
            { ...base, id: `obs_message_${index}`, stableKey: "message:0:assistant", kind: "CONTENT",
              payload: { role: "assistant" } },
          ]);
          database.insertRawObservation({
            id: `raw_${index}`, sourceRevisionId: revisionId, observationType: "FIXTURE_DOCUMENT",
            provenance: "LOCAL_FILE", dataClassification: "CONVERSATION_CONTENT",
            payloadReference: blob.relativePath, observedAt: occurredAt, sourceModifiedAt: occurredAt,
          });
        }
      });
      database.finishCollectionRun("collection_limit", "COMPLETED", "2026-03-02T00:00:00.000Z");
    } finally {
      database.close();
    }

    let sequence = 0;
    let message = "";
    try {
      await generateUsageReport({
        dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"), allowConversationContent: true,
        now: () => new Date("2026-03-10T00:00:00.000Z"), randomId: () => `limit-${++sequence}`,
      });
      assert.fail("expected the 100-revision limit to reject");
    } catch (error) {
      assert.ok(error instanceof Error);
      message = error.message;
    }
    assert.match(message, /limited to 100 revisions \(150 eligible in this scope\)/u);
    const firstWindow = message.match(/1\) --until (\S+)/u);
    const secondWindow = message.match(/2\) --since (\S+)$/mu);
    assert.ok(firstWindow, message);
    assert.ok(secondWindow, message);
    assert.equal(firstWindow![1], secondWindow![1]);
    assert.equal(/3\)/u.test(message), false, "150 revisions should split into exactly two windows of <=100");

    const reportOne = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage-1.json"), allowConversationContent: true,
      until: firstWindow![1]!, now: () => new Date("2026-03-10T00:00:00.000Z"),
      randomId: () => `limit1-${++sequence}`,
    });
    const reportTwo = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage-2.json"), allowConversationContent: true,
      since: secondWindow![1]!, now: () => new Date("2026-03-10T00:00:00.000Z"),
      randomId: () => `limit2-${++sequence}`,
    });
    assert.ok(reportOne.semantics.eligibleRevisions! <= 100);
    assert.ok(reportTwo.semantics.eligibleRevisions! <= 100);
    assert.equal(reportOne.semantics.eligibleRevisions! + reportTwo.semantics.eligibleRevisions!, total);
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

test("usage report exposes evidence deletion, OTel channels, and connected verification separately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-trust-"));
  try {
    const walking = await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "fixture.json"),
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => "trust-fixture",
    });
    const database = new AxtoryDatabase(walking.databasePath);
    try {
      const fact = database.inventory().analysisRecords.find((item) => item.key === "session.count");
      assert.ok(fact);
      database.insertVerificationRecord({
        id: "verification-trust", analysisRecordId: fact.analysisRecordId,
        verificationType: "HUMAN_ACCEPTANCE", status: "VERIFIED", provenance: "USER_PROVIDED",
        evidenceIds: [], note: "must not be exported", verifiedAt: "2026-08-09T00:01:00.000Z",
      });
      database.insertVerificationRecord({
        id: "verification-untrusted", analysisRecordId: fact.analysisRecordId,
        verificationType: "PRIVATE\nTYPE" as never, status: "UNTRUSTED\u001b" as never,
        provenance: "USER_PROVIDED", evidenceIds: [], note: null,
        verifiedAt: "2026-08-09T00:01:01.000Z",
      });
      database.insertUserAnnotation({
        id: "annotation-trust", targetType: "SOURCE_REVISION", targetId: walking.output.sourceRevisionId,
        assertion: "private annotation must not be exported", createdAt: "2026-08-09T00:01:00.000Z",
      });
    } finally {
      database.close();
    }

    const spool = new BoundedSpool(join(directory, "spool"));
    await spool.append({
      channel: "CLAUDE_OTEL_LOGS", receivedAt: "2026-08-09T00:02:00.000Z",
      payload: { resourceLogs: [{ scopeLogs: [{ logRecords: [{
        timeUnixNano: "1786233720000000000", attributes: [
          { key: "event.name", value: { stringValue: "api_request" } },
          { key: "model", value: { stringValue: "claude-synthetic-1" } },
          { key: "input_tokens", value: { intValue: "120" } },
          { key: "output_tokens", value: { intValue: "30" } },
          { key: "cost_usd", value: { doubleValue: 0.0123 } },
          { key: "duration_ms", value: { intValue: "456" } },
        ],
      }] }] }] },
    });
    await spool.append({
      channel: "CLAUDE_OTEL_METRICS", receivedAt: "2026-08-09T00:02:00.000Z",
      payload: { resourceMetrics: [{ scopeMetrics: [{ metrics: [{
        name: "claude_code.token.usage", unit: "tokens", sum: { dataPoints: [{
          asInt: "120", timeUnixNano: "1786233720000000000", attributes: [
            { key: "type", value: { stringValue: "input" } },
            { key: "model", value: { stringValue: "claude-synthetic-1" } },
          ],
        }] },
      }] }] }] },
    });
    let sequence = 0;
    await ingestLiveSpool({
      dataDirectory: directory, jsonOutputPath: join(directory, "live.json"),
      now: () => new Date("2026-08-09T00:03:00.000Z"), randomId: () => `live-${++sequence}`,
    });
    const untrustedDatabase = new AxtoryDatabase(walking.databasePath);
    try {
      const logRevision = untrustedDatabase.latestRevisions()
        .find((item) => item.sourceType === "CLAUDE_OTEL_LOGS");
      assert.ok(logRevision);
      untrustedDatabase.insertObservations([{
        id: "obs-untrusted-model", sourceRevisionId: logRevision.revisionId,
        stableKey: "otel-log:untrusted", kind: "EVENT", derivation: "OBSERVED",
        provenance: "OFFICIAL_API", dataClassification: "LOCAL_METADATA",
        occurredAt: "2026-08-09T00:02:01.000Z", timeQuality: "SOURCE_REPORTED",
        payload: { model: "PRIVATE\nMODEL", input_tokens: 1 },
      }]);
    } finally {
      untrustedDatabase.close();
    }
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      now: () => new Date("2026-08-09T00:04:00.000Z"), randomId: () => `usage-${++sequence}`,
    });
    assert.equal(report.evidence.status, "PRESENT");
    assert.equal(report.telemetry.availability, "AVAILABLE");
    assert.deepEqual(report.telemetry.categories, {
      tokens: "AVAILABLE", model: "AVAILABLE", cost: "AVAILABLE", latency: "AVAILABLE",
    });
    assert.equal(report.telemetry.facts.some((item) => item.channel === "EVENT" &&
      item.key === "telemetry.event.usage.input" && item.value === 121), true);
    assert.equal(report.telemetry.facts.some((item) => item.channel === "METRIC" &&
      item.key === "telemetry.metric.claude_code.token.usage" && item.value === 120), true);
    assert.equal(report.verification.availability, "AVAILABLE");
    assert.deepEqual(report.verification.byTypeAndStatus, [
      { verificationType: "HUMAN_ACCEPTANCE", status: "VERIFIED", count: 1 },
      { verificationType: "UNKNOWN", status: "UNKNOWN", count: 1 },
    ]);
    assert.equal(report.annotations.records, 1);
    const savedReport = await readFile(join(directory, "usage.json"), "utf8");
    assert.equal(savedReport.includes("must not be exported"), false);
    assert.equal(savedReport.includes("private annotation"), false);
    assert.equal(savedReport.includes("PRIVATE"), false);
    assert.equal(savedReport.includes("UNTRUSTED"), false);

    await executeSelectiveDeletion({
      dataDirectory: directory, mode: "DELETE_RAW_ONLY",
      target: { revisionIds: [walking.output.sourceRevisionId] }, confirmation: "DELETE_RAW_ONLY",
      now: () => new Date("2026-08-09T00:05:00.000Z"), randomId: () => "delete-trust",
    });
    const afterDeletion = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage-after-deletion.json"),
      now: () => new Date("2026-08-09T00:06:00.000Z"), randomId: () => `after-${++sequence}`,
    });
    assert.equal(afterDeletion.totals.availability, "PARTIAL");
    assert.equal(afterDeletion.evidence.status, "EVIDENCE_REMOVED");
    assert.equal(afterDeletion.evidence.revisionsWithoutRaw, 1);
    assert.equal(afterDeletion.verification.availability, "PARTIAL");
    assert.equal(afterDeletion.verification.analysisEvidence.evidenceRemoved, 2);
    const verifier = new AxtoryDatabase(walking.databasePath);
    try {
      assert.equal(verifier.inventory().analysisRecords.some((item) =>
        item.key === "usage.report.session.count" && item.evidenceStatus === "EVIDENCE_REMOVED"), true);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
