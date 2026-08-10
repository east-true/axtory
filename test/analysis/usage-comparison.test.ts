import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { compareUsageWindows, renderUsageComparison } from "../../src/analysis/usage-comparison.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";
import type { NormalizedObservation } from "../../src/core/records.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

async function seededDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-comparison-"));
  await runWalkingSkeleton({
    fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
    jsonOutputPath: join(directory, "fixture.json"),
    now: () => new Date("2026-01-02T04:00:00.000Z"), randomId: () => "comparison-fixture",
  });
  const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
  try {
    // Two synthetic sessions, one per window, so the comparison has a measured side each.
    for (const [index, day] of ["2026-03-01", "2026-04-01"].entries()) {
      const sourceObjectId = `source_window_${index}`;
      const revisionId = `revision_window_${index}`;
      database.upsertSourceObject(sourceObjectId, "FIXTURE", `window-session-${index}`);
      database.insertRevision({
        id: revisionId, sourceObjectId, contentHash: String(index).padStart(64, "0"),
        collectedAt: `${day}T00:00:00.000Z`, sourceModifiedAt: `${day}T00:00:00.000Z`,
        normalizerVersion: "comparison-test/1", payloadReference: "blobs/not-retained",
      });
      database.startCollectionRun(`collection_window_${index}`, "FIXTURE", `${day}T00:00:00.000Z`);
      database.linkCollectionRevision(
        `collection_window_${index}`, sourceObjectId, revisionId, `${day}T00:00:00.000Z`,
      );
      database.finishCollectionRun(`collection_window_${index}`, "COMPLETED", `${day}T00:01:00.000Z`);
      const base = {
        sourceRevisionId: revisionId, derivation: "OBSERVED" as const, provenance: "LOCAL_FILE" as const,
        dataClassification: "LOCAL_METADATA" as const, timeQuality: "SOURCE_REPORTED" as const,
      };
      const observations: NormalizedObservation[] = [
        { ...base, id: `obs_session_${index}`, stableKey: "session", kind: "SNAPSHOT",
          occurredAt: `${day}T00:00:00.000Z`, payload: { messageCoverage: "FULL" } },
        { ...base, id: `obs_user_${index}`, stableKey: "message:0:user", kind: "CONTENT",
          occurredAt: `${day}T00:01:00.000Z`, payload: { role: "user" } },
        { ...base, id: `obs_assistant_${index}`, stableKey: "message:1:assistant", kind: "CONTENT",
          occurredAt: `${day}T00:02:00.000Z`, payload: { role: "assistant" } },
        // The later window uses one more tool, so the tool difference is non-zero.
        ...Array.from({ length: index + 1 }, (_unused, tool): NormalizedObservation => ({
          ...base, id: `obs_tool_${index}_${tool}`, stableKey: `tool-occurrence:${tool}`, kind: "EVENT",
          occurredAt: `${day}T00:03:00.000Z`, payload: { toolName: "Bash" },
        })),
      ];
      database.insertObservations(observations);
    }
  } finally {
    database.close();
  }
  return directory;
}

test("usage comparison measures both windows and refuses to explain the difference", async () => {
  const directory = await seededDirectory();
  try {
    let sequence = 0;
    const output = await compareUsageWindows({
      dataDirectory: directory,
      jsonOutputPath: join(directory, "comparison.json"),
      earlier: { since: "2026-02-01T00:00:00.000Z", until: "2026-03-15T00:00:00.000Z" },
      later: { since: "2026-03-15T00:00:00.000Z", until: "2026-05-01T00:00:00.000Z" },
      sourceTypes: ["FIXTURE"],
      now: () => new Date("2026-05-02T00:00:00.000Z"), randomId: () => `comparison-${++sequence}`,
    });

    assert.equal(output.windows[0].label, "EARLIER");
    assert.equal(output.windows[1].label, "LATER");
    assert.equal(output.windows[0].sessions, 1);
    assert.equal(output.windows[1].sessions, 1);
    assert.equal(output.windows[0].toolInvocations, 1);
    assert.equal(output.windows[1].toolInvocations, 2);
    // Each window holds a subset of the collected fixture sources, so both sides are explicitly
    // partial and the difference inherits that rather than claiming a complete comparison.
    assert.equal(output.windows[0].availability, "PARTIAL");
    assert.equal(output.differences.availability, "PARTIAL");
    assert.match(output.differences.reason!, /inherits that uncertainty/u);
    assert.equal(output.differences.toolInvocations, 1);
    assert.equal(output.differences.sessions, 0);

    assert.ok(output.limitations.some((item) => /never establishes cause/u.test(item)));
    const rendered = renderUsageComparison(output);
    assert.match(rendered, /not evidence that the agent caused it/u);

    const written = JSON.parse(await readFile(join(directory, "comparison.json"), "utf8")) as
      typeof output;
    assert.equal(written.schemaVersion, "axtory.usage-comparison.v1");
    assert.equal(written.derivation, "CALCULATED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage comparison leaves a difference unknown when a window has no comparable usage", async () => {
  const directory = await seededDirectory();
  try {
    let sequence = 0;
    const output = await compareUsageWindows({
      dataDirectory: directory,
      earlier: { since: "2026-02-01T00:00:00.000Z", until: "2026-03-15T00:00:00.000Z" },
      later: { since: "2026-03-15T00:00:00.000Z", until: "2026-05-01T00:00:00.000Z" },
      sourceTypes: ["CODEX"],
      now: () => new Date("2026-05-02T00:00:00.000Z"), randomId: () => `unavailable-${++sequence}`,
    });

    assert.equal(output.windows[0].availability, "SOURCE_UNAVAILABLE");
    assert.equal(output.differences.availability, "UNKNOWN");
    assert.equal(output.differences.sessions, null);
    assert.equal(output.differences.toolInvocations, null);
    assert.deepEqual(output.toolCategoryShareDifference, []);
    assert.match(renderUsageComparison(output), /difference UNKNOWN/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage comparison without a json output path records no export run", async () => {
  const directory = await seededDirectory();
  try {
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    const before = database.count("export_runs");
    database.close();

    let sequence = 0;
    await compareUsageWindows({
      dataDirectory: directory,
      earlier: { until: "2026-03-15T00:00:00.000Z" },
      later: { since: "2026-03-15T00:00:00.000Z" },
      now: () => new Date("2026-05-02T00:00:00.000Z"), randomId: () => `no-export-${++sequence}`,
    });

    const verifier = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.equal(verifier.count("export_runs"), before);
    } finally {
      verifier.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
