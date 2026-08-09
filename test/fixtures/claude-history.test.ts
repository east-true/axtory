import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  normalizeClaudeHistoryFixture,
  parseClaudeHistoryFixture,
} from "../../src/fixtures/claude-history.js";
import { projectSession } from "../../src/projections/session.js";

const fixture = (name: string) => readFile(resolve("fixtures/synthetic", name));

test("missing source timestamps remain unavailable instead of using collection time", async () => {
  const parsed = parseClaudeHistoryFixture(await fixture("missing-fields.json"));
  const observations = normalizeClaudeHistoryFixture(parsed, "revision-missing-fields");
  const message = observations.find((item) => item.kind === "CONTENT");
  assert.equal(parsed.sourceModifiedAt, undefined);
  assert.equal(message?.occurredAt, null);
  assert.equal(message?.timeQuality, "ORDER_ONLY");
});

test("tool-heavy fixture separates repeated content identity from usage occurrence", async () => {
  const parsed = parseClaudeHistoryFixture(await fixture("tool-heavy-session.json"));
  const tools = normalizeClaudeHistoryFixture(parsed, "revision-tool-heavy")
    .filter((item) => item.stableKey.startsWith("tool-occurrence:"));
  assert.equal(tools.length, 3);
  assert.equal(tools[0]?.payload.contentIdentity, tools[2]?.payload.contentIdentity);
  assert.notEqual(tools[0]?.payload.usageOccurrenceId, tools[2]?.payload.usageOccurrenceId);
  assert.notEqual(tools[0]?.payload.contentIdentity, tools[1]?.payload.contentIdentity);
});

test("corrupted source fails explicitly without partial normalization", async () => {
  const bytes = await fixture("corrupted-source.json");
  assert.throws(
    () => parseClaudeHistoryFixture(bytes),
    /fixture is not valid JSON/u,
  );
});

test("unsupported fixture schema fails explicitly", async () => {
  const bytes = await fixture("unsupported-version.json");
  assert.throws(
    () => parseClaudeHistoryFixture(bytes),
    /does not match axtory\.fixture\.claude-history\.v1/u,
  );
});

test("resume fixture does not invent a lineage relation absent from the source view", async () => {
  const parsed = parseClaudeHistoryFixture(await fixture("resumed-session.json"));
  const observations = normalizeClaudeHistoryFixture(parsed, "revision-resumed");
  assert.equal(parsed.scenario, "RESUMED");
  assert.equal(observations.some((item) => item.kind === "RELATION"), false);
  assert.equal(projectSession(observations).messageCoverage, "COMPLETE_FOR_RETURNED_VIEW");
});

test("compacted and active fixtures preserve partial coverage", async () => {
  const compacted = parseClaudeHistoryFixture(await fixture("compacted-session.json"));
  const active = parseClaudeHistoryFixture(await fixture("active-session.json"));
  assert.equal(
    projectSession(normalizeClaudeHistoryFixture(compacted, "revision-compacted")).messageCoverage,
    "PARTIAL_COMPACTION",
  );
  assert.equal(
    projectSession(normalizeClaudeHistoryFixture(active, "revision-active")).messageCoverage,
    "PARTIAL_SOURCE_CHANGED",
  );
});

test("custom config fixture remains a separate source object", async () => {
  const parsed = parseClaudeHistoryFixture(await fixture("custom-config-dir.json"));
  assert.equal(parsed.scenario, "CUSTOM_CONFIG");
  assert.equal(parsed.sourceObjectKey, "synthetic-custom-config-session");
});
