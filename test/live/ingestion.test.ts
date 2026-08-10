import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { ingestLiveSpool } from "../../src/live/ingestion.js";
import { BoundedSpool } from "../../src/live/spool.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";

const receivedAt = "2026-08-09T00:00:00.000Z";

test("live ingestion reconciles spool state and extracts content-free Hook and OTel facts idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-live-ingestion-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    const spool = new BoundedSpool(join(directory, "spool"));
    const hookPayload = {
      hook_event_name: "PostToolUse", session_id: "sensitive-session-id", tool_name: "Write",
      tool_use_id: "sensitive-tool-id", tool_input: { path: "/private/repository/secret.ts" },
    };
    await spool.append({
      channel: "CLAUDE_HOOK", receivedAt, idempotencyKey: "hook-1",
      payload: hookPayload,
    });
    const log = await spool.append({
      channel: "CLAUDE_OTEL_LOGS", receivedAt, idempotencyKey: "logs-1",
      payload: {
        resourceLogs: [{
          resource: { attributes: [{ key: "user.email", value: { stringValue: "private@example.invalid" } }] },
          scopeLogs: [{ logRecords: [{
            timeUnixNano: "1786233600000000000",
            attributes: [
              { key: "event.name", value: { stringValue: "api_request" } },
              { key: "model", value: { stringValue: "claude-synthetic-1" } },
              { key: "input_tokens", value: { intValue: "120" } },
              { key: "output_tokens", value: { intValue: "30" } },
              { key: "cost_usd", value: { doubleValue: 0.0123 } },
              { key: "duration_ms", value: { intValue: "456" } },
              { key: "user_prompt", value: { stringValue: "private prompt must not normalize" } },
            ],
          }] }],
        }],
      },
    });
    await spool.transition(log.id, "PROCESSING", "2026-08-09T00:00:01.000Z");
    await spool.append({
      channel: "CLAUDE_OTEL_METRICS", receivedAt, idempotencyKey: "metrics-1",
      payload: {
        resourceMetrics: [{ scopeMetrics: [{ metrics: [{
          name: "claude_code.token.usage", unit: "tokens",
          sum: { dataPoints: [{
            asInt: "120", timeUnixNano: "1786233600000000000",
            attributes: [
              { key: "type", value: { stringValue: "input" } },
              { key: "model", value: { stringValue: "claude-synthetic-1" } },
            ],
          }] },
        }] }] }],
      },
    });
    let sequence = 0;
    const ingest = () => ingestLiveSpool({
      dataDirectory: directory, jsonOutputPath: join(directory, "live-output.json"),
      now: () => new Date("2026-08-09T01:00:00.000Z"), randomId: () => `live-${++sequence}`,
    });
    const first = await ingest();
    assert.equal(first.received, 3);
    assert.equal(first.ingested, 3);
    assert.equal(first.failed, 0);
    assert.equal(first.hookEvents, 1);
    assert.equal(first.otelObservations, 2);
    assert.equal(first.telemetryFacts, 6);
    assert.deepEqual(first.availability, {
      tokens: "AVAILABLE", model: "AVAILABLE", cost: "AVAILABLE", latency: "AVAILABLE",
    });
    assert.equal((await spool.listPending()).length, 0);
    const sanitizedOutput = await readFile(join(directory, "live-output.json"), "utf8");
    assert.equal(sanitizedOutput.includes("private@example.invalid"), false);
    assert.equal(sanitizedOutput.includes("private prompt"), false);

    const database = new DatabaseSync(join(directory, "axtory.sqlite3"), { readOnly: true });
    try {
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM source_revisions`).get() as { count: number }).count, 3);
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM raw_observations`).get() as { count: number }).count, 3);
      const normalized = database.prepare(`SELECT group_concat(payload_json, ' ') AS payload
        FROM normalized_observations`).get() as { payload: string };
      assert.equal(normalized.payload.includes("private@example.invalid"), false);
      assert.equal(normalized.payload.includes("private prompt"), false);
      assert.equal(normalized.payload.includes("/private/repository"), false);
      const cost = database.prepare(`SELECT reason FROM analysis_records WHERE key LIKE 'telemetry.event.cost.%'`)
        .get() as { reason: string };
      assert.match(cost.reason, /estimate.*billing/u);
    } finally {
      database.close();
    }

    await spool.append({
      channel: "CLAUDE_HOOK", receivedAt, idempotencyKey: "hook-1",
      payload: hookPayload,
    });
    const second = await ingest();
    assert.equal(second.ingested, 0);
    assert.equal(second.duplicates, 1);
    const verifier = new DatabaseSync(join(directory, "axtory.sqlite3"), { readOnly: true });
    try {
      assert.equal((verifier.prepare(`SELECT COUNT(*) AS count FROM source_revisions`).get() as { count: number }).count, 3);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing telemetry categories stay NOT_COLLECTED rather than becoming zero", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-live-availability-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    const spool = new BoundedSpool(join(directory, "spool"));
    await spool.append({
      channel: "CLAUDE_HOOK", receivedAt,
      payload: { hook_event_name: "Stop", session_id: "synthetic" },
    });
    const summary = await ingestLiveSpool({
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"),
    });
    assert.deepEqual(summary.availability, {
      tokens: "NOT_COLLECTED", model: "NOT_COLLECTED",
      cost: "NOT_COLLECTED", latency: "NOT_COLLECTED",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
