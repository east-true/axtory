import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestLiveSpool } from "../../src/live/ingestion.js";
import { BoundedSpool } from "../../src/live/spool.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";

test("token-only OTel facts report token availability without requiring model, cost, or latency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-live-token-availability-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    const spool = new BoundedSpool(join(directory, "spool"));
    await spool.append({
      channel: "CLAUDE_OTEL_LOGS",
      receivedAt: "2026-08-09T00:00:00.000Z",
      idempotencyKey: "token-only",
      payload: {
        resourceLogs: [{ scopeLogs: [{ logRecords: [{
          timeUnixNano: "1786233600000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "api_request" } },
            { key: "input_tokens", value: { intValue: "12" } },
          ],
        }] }] }],
      },
    });

    const summary = await ingestLiveSpool({
      dataDirectory: directory,
      jsonOutputPath: join(directory, "output.json"),
      now: () => new Date("2026-08-09T01:00:00.000Z"),
      randomId: () => "token-only",
    });

    assert.equal(summary.telemetryFacts, 1);
    assert.deepEqual(summary.availability, {
      tokens: "AVAILABLE",
      model: "NOT_COLLECTED",
      cost: "NOT_COLLECTED",
      latency: "NOT_COLLECTED",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
