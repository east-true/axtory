import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

test("synthetic fixture crosses the full pipeline and repeated collection is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-walking-skeleton-"));
  try {
    const fixturePath = resolve("fixtures/synthetic/normal-session.json");
    const jsonOutputPath = join(directory, "output.json");
    let sequence = 0;
    const run = () => runWalkingSkeleton({
      fixturePath,
      dataDirectory: directory,
      jsonOutputPath,
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      randomId: () => `deterministic-${++sequence}`,
    });
    const first = await run();
    const second = await run();
    assert.equal(first.output.revisionCreated, true);
    assert.equal(second.output.revisionCreated, false);
    assert.deepEqual(
      second.output.metrics.filter((item) => item.availability === "AVAILABLE")
        .map((item) => [item.key, item.value, item.derivation]),
      [
        ["session.count", 1, "CALCULATED"],
        ["message.count", 3, "CALCULATED"],
        ["tool.invocation.count", 2, "CALCULATED"],
      ],
    );
    const tokens = second.output.metrics.find((item) => item.key === "usage.input.tokens");
    assert.equal(tokens?.value, null);
    assert.equal(tokens?.availability, "NOT_COLLECTED");
    assert.match(tokens?.reason ?? "", /not used as authoritative token telemetry/u);

    const storedOutput = JSON.parse(await readFile(jsonOutputPath, "utf8")) as Record<string, unknown>;
    assert.equal(storedOutput.schemaVersion, "axtory.walking-skeleton-output.v1");
    assert.equal(JSON.stringify(storedOutput).includes("synthetic greeting"), false);

    const database = new AxtoryDatabase(first.databasePath);
    try {
      assert.equal(database.count("collection_runs"), 2);
      assert.equal(database.count("source_revisions"), 1);
      assert.equal(database.count("raw_observations"), 1);
      assert.equal(database.count("normalized_observations"), 6);
      assert.equal(database.count("analysis_runs"), 2);
      assert.equal(database.count("export_runs"), 2);
      const tools = database.observationsForRevision(first.output.sourceRevisionId)
        .filter((item) => item.stableKey.startsWith("tool-occurrence:"));
      assert.equal(tools.length, 2);
      assert.equal(tools[0]?.payload.contentIdentity, tools[1]?.payload.contentIdentity);
      assert.notEqual(tools[0]?.payload.usageOccurrenceId, tools[1]?.payload.usageOccurrenceId);
    } finally {
      database.close();
    }

    const interrupted = new AxtoryDatabase(first.databasePath);
    interrupted.startCollectionRun("collection-interrupted", "FIXTURE", "2026-08-08T00:00:00.000Z");
    interrupted.close();
    await run();
    const verifier = new DatabaseSync(first.databasePath, { readOnly: true });
    try {
      const row = verifier.prepare("SELECT status, error_code FROM collection_runs WHERE id = ?")
        .get("collection-interrupted") as { status: string; error_code: string };
      assert.equal(row.status, "FAILED");
      assert.equal(row.error_code, "INTERRUPTED");
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
