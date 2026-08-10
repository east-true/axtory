import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startLiveReceiver } from "../../src/live/receiver.js";
import { BoundedSpool } from "../../src/live/spool.js";

test("live receiver binds loopback, authenticates, deduplicates request ids, and spools without blocking hooks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-live-receiver-"));
  const token = "synthetic-token-that-is-at-least-32-characters";
  const receiver = await startLiveReceiver({ dataDirectory: directory, token });
  try {
    assert.match(receiver.endpoint, /^http:\/\/127\.0\.0\.1:\d+$/u);
    const unauthorized = await fetch(`${receiver.endpoint}/health`);
    assert.equal(unauthorized.status, 401);
    const health = await fetch(`${receiver.endpoint}/health`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200);
    const send = () => fetch(`${receiver.endpoint}/hooks/PostToolUse`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-request-id": "same-hook-delivery",
      },
      body: JSON.stringify({ session_id: "sensitive-session-id", hook_event_name: "PostToolUse" }),
    });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    const pending = await new BoundedSpool(join(directory, "spool")).listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.channel, "CLAUDE_HOOK");
    assert.deepEqual(pending[0]?.states.map((item) => item.state), ["STARTED", "RECEIVED"]);

    const otel = await fetch(`${receiver.endpoint}/v1/metrics`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ resourceMetrics: [] }),
    });
    assert.equal(otel.status, 200);
    assert.equal((await new BoundedSpool(join(directory, "spool")).listPending()).length, 2);
  } finally {
    await receiver.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded spool refuses capacity overflow and enforces terminal transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-"));
  try {
    const spool = new BoundedSpool(directory, { maximumItems: 1, maximumBytes: 1024 * 1024 });
    const first = await spool.append({
      channel: "CLAUDE_HOOK", payload: { event: "one" }, receivedAt: "2026-08-09T00:00:00.000Z",
    });
    await assert.rejects(() => spool.append({
      channel: "CLAUDE_HOOK", payload: { event: "two" }, receivedAt: "2026-08-09T00:00:01.000Z",
    }), /capacity exceeded/u);
    await spool.transition(first.id, "PROCESSING", "2026-08-09T00:00:02.000Z");
    await spool.transition(first.id, "COMPLETED", "2026-08-09T00:00:03.000Z");
    assert.equal((await spool.listPending()).length, 0);
    await assert.rejects(() => spool.transition(first.id, "PROCESSING", "2026-08-09T00:00:04.000Z"),
      /invalid spool transition/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
