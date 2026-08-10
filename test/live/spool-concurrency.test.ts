import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BoundedSpool, type SpoolEnvelope } from "../../src/live/spool.js";

async function entries(root: string): Promise<string[]> {
  return (await readdir(join(root, "spool"))).sort();
}

test("concurrent appends sharing one request id keep the first event and report the rest as duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-race-"));
  try {
    const spool = new BoundedSpool(join(directory, "spool"));
    // The receiver takes its idempotency key from x-request-id. Two requests can carry the same id
    // and different payloads; the existence check alone cannot separate them under concurrency.
    const results = await Promise.all([
      spool.append({
        channel: "CLAUDE_HOOK", payload: { event: "FIRST" },
        receivedAt: "2026-08-09T00:00:00.000Z", idempotencyKey: "shared",
      }),
      spool.append({
        channel: "CLAUDE_HOOK", payload: { event: "SECOND" },
        receivedAt: "2026-08-09T00:00:01.000Z", idempotencyKey: "shared",
      }),
    ]);

    assert.equal(results.filter((item) => !item.duplicate).length, 1);
    assert.equal(results.filter((item) => item.duplicate).length, 1);

    // Exactly one entry, no temporary file left behind, and the retained payload is intact rather
    // than a half-written or silently replaced one.
    const files = await entries(directory);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^spool_[0-9a-f]{32}\.json$/u);
    const envelope = JSON.parse(
      await readFile(join(directory, "spool", files[0]!), "utf8"),
    ) as SpoolEnvelope;
    assert.deepEqual(envelope.payload, { event: "FIRST" });
    assert.equal(envelope.states.at(-1)?.state, "RECEIVED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a wider race still admits exactly one entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-race-wide-"));
  try {
    const spool = new BoundedSpool(join(directory, "spool"));
    const results = await Promise.all(Array.from({ length: 8 }, (_value, index) => spool.append({
      channel: "CLAUDE_OTEL_LOGS", payload: { index },
      receivedAt: "2026-08-09T00:00:00.000Z", idempotencyKey: "retried",
    })));
    assert.equal(results.filter((item) => !item.duplicate).length, 1);
    assert.equal(results.filter((item) => item.duplicate).length, 7);
    assert.equal((await entries(directory)).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("distinct request ids are all accepted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-distinct-"));
  try {
    const spool = new BoundedSpool(join(directory, "spool"));
    const results = await Promise.all(Array.from({ length: 5 }, (_value, index) => spool.append({
      channel: "CLAUDE_HOOK", payload: { index },
      receivedAt: "2026-08-09T00:00:00.000Z", idempotencyKey: `request-${index}`,
    })));
    assert.equal(results.filter((item) => item.duplicate).length, 0);
    assert.equal((await entries(directory)).length, 5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
