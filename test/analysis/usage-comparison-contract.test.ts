import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { compareUsageWindows } from "../../src/analysis/usage-comparison.js";
import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";

test("an inverted window pair is rejected before it can report reversed differences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-comparison-order-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(directory, "data"));
    // Every difference is `later - earlier` and is rendered with a sign under "Earlier"/"Later"
    // headings, so a later window starting first would invert the direction of the whole report.
    await assert.rejects(() => compareUsageWindows({
      dataDirectory,
      earlier: { since: "2026-08-01T00:00:00Z", until: "2026-08-08T00:00:00Z" },
      later: { since: "2026-07-01T00:00:00Z", until: "2026-07-08T00:00:00Z" },
    }), /later comparison window must not begin before the earlier window/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exporting a comparison records an export run like every other sink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-comparison-export-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(directory, "data"));
    const jsonOutputPath = join(directory, "comparison.json");
    await compareUsageWindows({
      dataDirectory, jsonOutputPath,
      earlier: { since: "2026-07-01T00:00:00Z", until: "2026-07-08T00:00:00Z" },
      later: { since: "2026-08-01T00:00:00Z", until: "2026-08-08T00:00:00Z" },
    });

    const database = new DatabaseSync(join(dataDirectory, "axtory.sqlite3"));
    try {
      const rows = database.prepare(
        `SELECT sink, destination, policy_version, record_count, status, payload_digest
         FROM export_runs`,
      ).all() as Array<Record<string, string | number>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.sink, "JSON_FILE");
      assert.equal(rows[0]?.destination, jsonOutputPath);
      assert.equal(rows[0]?.status, "COMPLETED");
      assert.equal(rows[0]?.record_count, 2);
      assert.match(String(rows[0]?.payload_digest), /^[0-9a-f]{64}$/u);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a comparison without a JSON path writes nothing and records nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-comparison-noexport-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(join(directory, "data"));
    await compareUsageWindows({
      dataDirectory,
      earlier: { since: "2026-07-01T00:00:00Z", until: "2026-07-08T00:00:00Z" },
      later: { since: "2026-08-01T00:00:00Z", until: "2026-08-08T00:00:00Z" },
    });
    const database = new DatabaseSync(join(dataDirectory, "axtory.sqlite3"));
    try {
      const row = database.prepare(`SELECT COUNT(*) AS count FROM export_runs`).get() as { count: number };
      assert.equal(row.count, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
