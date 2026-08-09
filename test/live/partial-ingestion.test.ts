import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ingestLiveSpool } from "../../src/live/ingestion.js";
import { BoundedSpool } from "../../src/live/spool.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

const receivedAt = "2026-08-09T00:00:00.000Z";

test("one unusable live envelope does not hide the telemetry ingested beside it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-partial-ingestion-"));
  try {
    await ensureAxtoryDataDirectory(directory);
    const spool = new BoundedSpool(join(directory, "spool"));
    // A Hook payload must be an object; a bare array reaches the spool but fails normalization.
    await spool.append({ channel: "CLAUDE_HOOK", receivedAt, idempotencyKey: "broken-1", payload: [] });
    await spool.append({
      channel: "CLAUDE_OTEL_LOGS", receivedAt, idempotencyKey: "logs-1",
      payload: {
        resourceLogs: [{ scopeLogs: [{ logRecords: [{
          timeUnixNano: "1786233600000000000",
          attributes: [
            { key: "event.name", value: { stringValue: "api_request" } },
            { key: "input_tokens", value: { intValue: "120" } },
          ],
        }] }] }],
      },
    });

    const summary = await ingestLiveSpool({
      dataDirectory: directory, jsonOutputPath: join(directory, "ingestion.json"),
    });
    assert.equal(summary.failed, 1);
    assert.equal(summary.ingested, 1);

    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      // A failed run is excluded from head selection, so failing the whole run would erase the
      // successfully ingested OTel revision from every later usage report.
      const heads = database.latestRevisions();
      assert.equal(heads.length, 1);
      assert.equal(heads[0]?.sourceType, "CLAUDE_OTEL_LOGS");
      assert.equal(heads[0]?.headSelection, "COMPLETED_COLLECTION");
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
