import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startLiveReceiver } from "../../src/live/receiver.js";

test("unauthenticated traffic does not consume the authenticated request budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-receiver-budget-"));
  const receiver = await startLiveReceiver({
    dataDirectory: directory, token: "x".repeat(32), maximumRequestsPerMinute: 3,
  });
  try {
    // Any local process can reach loopback. If its rejected requests were metered, Claude's own
    // hook posts would start failing non-blockingly and their events would be lost.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const unauthorized = await fetch(`${receiver.endpoint}/hooks/PostToolUse`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      assert.equal(unauthorized.status, 401);
    }

    const authorized = await fetch(`${receiver.endpoint}/hooks/PostToolUse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}`, "x-request-id": "hook-1" },
      body: JSON.stringify({ hook_event_name: "PostToolUse" }),
    });
    assert.equal(authorized.status, 200);
  } finally {
    await receiver.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the authenticated budget still applies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-receiver-limit-"));
  const receiver = await startLiveReceiver({
    dataDirectory: directory, token: "y".repeat(32), maximumRequestsPerMinute: 2,
  });
  try {
    const post = (id: string) => fetch(`${receiver.endpoint}/hooks/PostToolUse`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${receiver.token}`, "x-request-id": id },
      body: JSON.stringify({ hook_event_name: "PostToolUse" }),
    });
    assert.equal((await post("a")).status, 200);
    assert.equal((await post("b")).status, 200);
    assert.equal((await post("c")).status, 429);
  } finally {
    await receiver.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
