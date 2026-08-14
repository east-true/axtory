import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BoundedSpool } from "../../src/live/spool.js";

test("concurrent distinct appends cannot exceed the configured item capacity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-capacity-"));
  try {
    const spool = new BoundedSpool(join(directory, "spool"), {
      maximumItems: 1,
      maximumBytes: 1024 * 1024,
    });
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
