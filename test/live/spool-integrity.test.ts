import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BoundedSpool } from "../../src/live/spool.js";

test("live spool rejects a payload that no longer matches its stored digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-integrity-"));
  try {
    const spool = new BoundedSpool(directory);
    const created = await spool.append({
      channel: "CLAUDE_HOOK",
      receivedAt: "2026-08-09T00:00:00.000Z",
      idempotencyKey: "tamper",
      payload: { hook_event_name: "Stop", session_id: "original" },
    });
    const path = join(directory, `${created.id}.json`);
    const envelope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    envelope.payload = { hook_event_name: "Stop", session_id: "tampered" };
    await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");

    await assert.rejects(spool.listPending(), /payload does not match its digest/u);
    await assert.rejects(
      spool.append({
        channel: "CLAUDE_HOOK",
        receivedAt: "2026-08-09T00:00:01.000Z",
        idempotencyKey: "tamper",
        payload: { hook_event_name: "Stop", session_id: "original" },
      }),
      /payload does not match its digest/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live spool rejects an envelope whose internal id differs from its filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-spool-id-"));
  try {
    const spool = new BoundedSpool(directory);
    const created = await spool.append({
      channel: "CLAUDE_HOOK",
      receivedAt: "2026-08-09T00:00:00.000Z",
      idempotencyKey: "id-mismatch",
      payload: { hook_event_name: "Stop" },
    });
    const path = join(directory, `${created.id}.json`);
    const envelope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    envelope.id = `spool_${"f".repeat(32)}`;
    await writeFile(path, `${JSON.stringify(envelope)}\n`, "utf8");

    await assert.rejects(spool.listPending(), /invalid envelope/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
