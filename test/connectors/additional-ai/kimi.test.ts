import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { KimiCodeSourceApi } from "../../../src/connectors/additional-ai/kimi.js";

// Layout and event names come from the official Kimi Code CLI documentation: sessions live under
// `$KIMI_CODE_HOME` with a `session_index.jsonl` of {sessionId, sessionDir, workDir}, and
// `agents/main/wire.jsonl` carries JSON-RPC 2.0 wire events.
const lines = (...values: unknown[]) => values.map((v) => JSON.stringify(v)).join("\n") + "\n";

async function store(options: { workDir: string; wire?: string; state?: unknown } = { workDir: "" }) {
  const home = await mkdtemp(join(tmpdir(), "axtory-kimi-home-"));
  const sessionDir = join(home, "sessions", "workkey", "session-1");
  await mkdir(join(sessionDir, "agents", "main"), { recursive: true });
  await writeFile(join(home, "session_index.jsonl"),
    lines({ sessionId: "session-1", sessionDir, workDir: options.workDir }), "utf8");
  if (options.state !== undefined) {
    await writeFile(join(sessionDir, "state.json"), JSON.stringify(options.state), "utf8");
  }
  if (options.wire !== undefined) {
    await writeFile(join(sessionDir, "agents", "main", "wire.jsonl"), options.wire, "utf8");
  }
  return home;
}

test("sessions are scoped to the project directory the index records", async () => {
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-proj-"));
  const home = await store({ workDir: project });
  try {
    const inScope = await new KimiCodeSourceApi({ projectDirectory: project, home })
      .listSessions({ limit: 10 });
    assert.equal(inScope.items.length, 1);
    assert.equal(inScope.coverage, "COMPLETE_FOR_RETURNED_VIEW");

    const elsewhere = await new KimiCodeSourceApi({ projectDirectory: tmpdir(), home })
      .listSessions({ limit: 10 });
    assert.deepEqual(elsewhere.items, []);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("an absent session index is an empty history, not a failure", async () => {
  const home = await mkdtemp(join(tmpdir(), "axtory-kimi-empty-"));
  try {
    const listed = await new KimiCodeSourceApi({ projectDirectory: tmpdir(), home })
      .listSessions({ limit: 10 });
    assert.deepEqual(listed.items, []);
    assert.equal(listed.coverage, "COMPLETE_FOR_RETURNED_VIEW");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("documented wire events become message and tool occurrences without copying content", async () => {
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-wire-"));
  const secret = "PRIVATE-PROMPT-TEXT";
  const home = await store({
    workDir: project,
    state: { title: "synthetic", createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-10T01:00:00Z" },
    wire: lines(
      { jsonrpc: "2.0", id: 1, method: "prompt", params: { text: secret } },
      { jsonrpc: "2.0", method: "event", params: { type: "ContentPart", kind: "text", text: "ASSISTANT-TEXT" } },
      { jsonrpc: "2.0", method: "event", params: { ToolCall: { name: "read_file", path: "/private/x" } } },
      { jsonrpc: "2.0", method: "event", params: { type: "ToolResult", output: "TOOL-OUTPUT" } },
      { jsonrpc: "2.0", method: "event", params: { type: "StatusUpdate" } },
    ),
  });
  try {
    const api = new KimiCodeSourceApi({ projectDirectory: project, home });
    const [summary] = (await api.listSessions({ limit: 10 })).items;
    const view = await api.readSession(summary!);

    assert.equal(view.coverage, "COMPLETE_FOR_RETURNED_VIEW");
    assert.deepEqual(view.messages.map((m) => m.role), ["USER", "ASSISTANT", "TOOL", "TOOL"]);
    assert.equal(view.summary.createdAt, "2026-08-10T00:00:00.000Z");
    assert.equal(view.summary.sourceUpdatedAt, "2026-08-10T01:00:00.000Z");
    assert.equal(view.provenance, "DOCUMENTED_STORAGE");

    // Content identity is hashed; the canonical message list never carries the text itself.
    const serialized = JSON.stringify(view.messages);
    for (const needle of [secret, "ASSISTANT-TEXT", "TOOL-OUTPUT", "/private/x"]) {
      assert.equal(serialized.includes(needle), false, `${needle} leaked into messages`);
    }
    assert.match(String(view.messages[0]!.contentIdentity), /^[0-9a-f]{64}$/u);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("a compacted session keeps partial coverage", async () => {
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-compact-"));
  const home = await store({
    workDir: project,
    wire: lines(
      { jsonrpc: "2.0", method: "event", params: { type: "CompactionBegin" } },
      { jsonrpc: "2.0", method: "event", params: { type: "ContentPart", kind: "text" } },
    ),
  });
  try {
    const api = new KimiCodeSourceApi({ projectDirectory: project, home });
    const [summary] = (await api.listSessions({ limit: 10 })).items;
    assert.equal((await api.readSession(summary!)).coverage, "PARTIAL_COMPACTION");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("a wire log whose lines match nothing documented fails instead of reading as empty", async () => {
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-format-"));
  const home = await store({
    workDir: project,
    wire: lines({ some: "future format" }, { another: "unrecognized line" }),
  });
  try {
    const api = new KimiCodeSourceApi({ projectDirectory: project, home });
    const [summary] = (await api.listSessions({ limit: 10 })).items;
    await assert.rejects(() => api.readSession(summary!), /no documented JSON-RPC event/u);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("a missing agent log is an unknown view rather than a session with no messages", async () => {
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-nowire-"));
  const home = await store({ workDir: project });
  try {
    const api = new KimiCodeSourceApi({ projectDirectory: project, home });
    const [summary] = (await api.listSessions({ limit: 10 })).items;
    const view = await api.readSession(summary!);
    assert.equal(view.coverage, "UNKNOWN");
    assert.deepEqual(view.messages, []);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("an index record pointing outside the configured home is refused", async () => {
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-escape-"));
  const home = await mkdtemp(join(tmpdir(), "axtory-kimi-escape-home-"));
  try {
    await writeFile(join(home, "session_index.jsonl"),
      lines({ sessionId: "session-1", sessionDir: "/etc", workDir: project }), "utf8");
    const api = new KimiCodeSourceApi({ projectDirectory: project, home });
    const [summary] = (await api.listSessions({ limit: 10 })).items;
    await assert.rejects(() => api.readSession(summary!), /escapes the configured home/u);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test("an unreadable index record keeps the listing partial", async () => {
  const project = await mkdtemp(join(tmpdir(), "axtory-kimi-partial-"));
  const home = await mkdtemp(join(tmpdir(), "axtory-kimi-partial-home-"));
  try {
    await writeFile(join(home, "session_index.jsonl"),
      `${JSON.stringify({ sessionId: "session-1", sessionDir: join(home, "s1"), workDir: project })}\nnot json\n`,
      "utf8");
    const listed = await new KimiCodeSourceApi({ projectDirectory: project, home })
      .listSessions({ limit: 10 });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.coverage, "PARTIAL_LIMIT");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});
