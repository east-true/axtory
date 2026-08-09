import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { parseClaudeHistoryFixture } from "../../src/fixtures/claude-history.js";
import { isoFromEpoch, isoTimestamp } from "../../src/core/time.js";

test("source timestamps normalize to UTC so window and calendar-day comparisons stay correct", () => {
  assert.equal(isoTimestamp("2026-08-11T02:00:00+09:00"), "2026-08-10T17:00:00.000Z");
  assert.equal(isoTimestamp("2026-08-10T17:00:00Z"), "2026-08-10T17:00:00.000Z");
  assert.equal(isoTimestamp("not-a-timestamp"), null);
  assert.equal(isoTimestamp(1_786_233_600_000), null);
  assert.equal(isoFromEpoch(1_786_233_600_000, "MILLISECONDS"), "2026-08-09T00:00:00.000Z");
  assert.equal(isoFromEpoch(1_786_233_600, "SECONDS"), "2026-08-09T00:00:00.000Z");
  assert.equal(isoFromEpoch(Number.NaN, "MILLISECONDS"), null);
  assert.equal(isoFromEpoch("1786233600000", "MILLISECONDS"), null);
});

test("a fixture offset timestamp is stored as its UTC instant, not its local wall clock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-fixture-time-"));
  try {
    const fixturePath = join(directory, "offset-session.json");
    await writeFile(fixturePath, JSON.stringify({
      schemaVersion: "axtory.fixture.claude-history.v1",
      sourceObjectKey: "offset-session",
      sourceModifiedAt: "2026-08-11T02:00:00+09:00",
      session: {
        id: "offset-session",
        messages: [{
          id: "m1",
          role: "user",
          // 2026-08-11 in +09:00 is still 2026-08-10 in UTC. A raw passthrough would bucket this
          // observation into the wrong UTC day and compare incorrectly against UTC report bounds.
          occurredAt: "2026-08-11T02:00:00+09:00",
          blocks: [{ type: "text", text: "synthetic" }],
        }],
      },
    }), "utf8");
    const dataDirectory = join(directory, "data");
    await runWalkingSkeleton({
      fixturePath,
      dataDirectory,
      jsonOutputPath: join(directory, "output.json"),
    });
    const database = new DatabaseSync(join(dataDirectory, "axtory.sqlite3"));
    try {
      const rows = database.prepare(
        `SELECT occurred_at FROM normalized_observations WHERE kind = 'CONTENT'`,
      ).all() as Array<{ occurred_at: string }>;
      assert.deepEqual(rows.map((row) => row.occurred_at), ["2026-08-10T17:00:00.000Z"]);
      const revision = database.prepare(
        `SELECT source_modified_at FROM source_revisions`,
      ).get() as { source_modified_at: string };
      assert.equal(revision.source_modified_at, "2026-08-10T17:00:00.000Z");
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a fixture timestamp that is not parseable fails explicitly instead of reaching storage", () => {
  const invalidMessageTime = Buffer.from(JSON.stringify({
    schemaVersion: "axtory.fixture.claude-history.v1",
    sourceObjectKey: "invalid-time",
    session: { id: "invalid-time", messages: [{ id: "m1", role: "user", occurredAt: "yesterday", blocks: [] }] },
  }), "utf8");
  assert.throws(() => parseClaudeHistoryFixture(invalidMessageTime), /occurredAt/u);
  const invalidSourceModified = Buffer.from(JSON.stringify({
    schemaVersion: "axtory.fixture.claude-history.v1",
    sourceObjectKey: "invalid-time",
    sourceModifiedAt: "soon",
    session: { id: "invalid-time", messages: [] },
  }), "utf8");
  assert.throws(() => parseClaudeHistoryFixture(invalidSourceModified), /sourceModifiedAt/u);
});
