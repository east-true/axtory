import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BoundedSpool } from "../../src/live/spool.js";

const limits = { maximumItems: 1, maximumBytes: 1024 * 1024 };

test("concurrent distinct appends cannot exceed the configured item capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-capacity-"));
  try {
    const spool = new BoundedSpool(join(directory, "spool"), limits);
    const results = await Promise.allSettled(Array.from({ length: 32 }, (_value, index) => spool.append({
      channel: "CLAUDE_HOOK",
      payload: { index },
      receivedAt: "2026-08-14T00:00:00.000Z",
      idempotencyKey: `request-${index}`,
    })));

    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 31);
    for (const result of results) {
      if (result.status === "rejected") assert.match(String(result.reason), /capacity exceeded/u);
    }
    assert.equal((await readdir(join(directory, "spool"))).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate spool instances sharing one directory cannot race past capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-cross-instance-"));
  try {
    const root = join(directory, "spool");
    const first = new BoundedSpool(root, limits);
    const second = new BoundedSpool(root, limits);
    const results = await Promise.allSettled([
      first.append({
        channel: "CLAUDE_HOOK", payload: { source: "first" },
        receivedAt: "2026-08-14T00:00:00.000Z", idempotencyKey: "first",
      }),
      second.append({
        channel: "CLAUDE_HOOK", payload: { source: "second" },
        receivedAt: "2026-08-14T00:00:00.000Z", idempotencyKey: "second",
      }),
    ]);

    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    const rejected = results.find((item) => item.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.match(String(rejected.reason), /capacity exceeded/u);
    assert.equal((await readdir(root)).filter((entry) => entry.endsWith(".json")).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
