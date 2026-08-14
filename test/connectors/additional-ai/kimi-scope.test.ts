import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { KimiCodeSourceApi } from "../../../src/connectors/additional-ai/kimi.js";

const lines = (...values: unknown[]) => values.map((value) => JSON.stringify(value)).join("\n") + "\n";

test("reading a listed Kimi session stays inside the project scope when another project reuses the session id", async () => {
  const home = await mkdtemp(join(tmpdir(), "axtory-kimi-duplicate-home-"));
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-duplicate-project-"));
  const otherProject = await mkdtemp(join(tmpdir(), "axtory-kimi-duplicate-other-"));
  const validSession = join(home, "sessions", "target", "session-1");
  const otherSession = join(home, "sessions", "other", "session-1");
  try {
    await mkdir(join(validSession, "agents", "main"), { recursive: true });
    await mkdir(join(otherSession, "agents", "main"), { recursive: true });
    await writeFile(join(home, "session_index.jsonl"), lines(
      { sessionId: "session-1", sessionDir: otherSession, workDir: otherProject },
      { sessionId: "session-1", sessionDir: validSession, workDir: project },
    ), "utf8");
    await writeFile(join(otherSession, "state.json"), JSON.stringify({ createdAt: "2026-01-01T00:00:00Z" }), "utf8");
    await writeFile(join(validSession, "state.json"), JSON.stringify({ createdAt: "2026-02-01T00:00:00Z" }), "utf8");
    await writeFile(join(otherSession, "agents", "main", "wire.jsonl"),
      lines({ jsonrpc: "2.0", method: "prompt", params: { text: "other" } }), "utf8");
    await writeFile(join(validSession, "agents", "main", "wire.jsonl"),
      lines({ jsonrpc: "2.0", method: "prompt", params: { text: "target" } }), "utf8");

    const api = new KimiCodeSourceApi({ projectDirectory: project, home });
    const [summary] = (await api.listSessions({ limit: 10 })).items;
    assert.ok(summary);
    const view = await api.readSession(summary);
    assert.equal(view.summary.createdAt, "2026-02-01T00:00:00.000Z");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
    await rm(otherProject, { recursive: true, force: true });
  }
});
