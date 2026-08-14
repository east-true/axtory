import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { collectClaudeHistory } from "../../../src/connectors/claude/collector.js";
import type { ClaudeDiscovery } from "../../../src/connectors/claude/discovery.js";
import type { ClaudeHistoryApi } from "../../../src/connectors/claude/history-api.js";
import { AxtoryDatabase } from "../../../src/core/storage.js";

const discovery: ClaudeDiscovery = {
  environment: {
    id: "environment",
    type: "LINUX",
    os: "linux",
    architecture: "x64",
    homeDirectory: { status: "AVAILABLE", value: "/synthetic-home" },
  },
  sourceProfile: {
    id: "profile",
    sourceType: "CLAUDE_CODE",
    environmentId: "environment",
    dataRoot: { status: "AVAILABLE", value: "/synthetic-root" },
    executablePath: { status: "AVAILABLE", value: "/synthetic-bin/claude" },
    activeVersion: { status: "AVAILABLE", value: "1.2.3" },
  },
  capabilityAssessment: {
    sourceProfileId: "profile",
    assessedAt: "2026-08-09T00:00:00.000Z",
    capabilities: [
      { key: "claude.installation", availability: "AVAILABLE", evidence: ["synthetic"] },
      { key: "claude.data_root", availability: "AVAILABLE", evidence: ["synthetic"] },
      { key: "claude.auth", availability: "AVAILABLE", evidence: ["synthetic"] },
    ],
  },
  authMethod: null,
};

test("official history collector is incremental and excludes content from output", async () => {
  const secret = "PRIVATE-SYNTHETIC-PROMPT";
  const sessions = [
    { sessionId: "session-1", lastModified: 1_700_000_000_000, createdAt: 1_699_999_000_000 },
    { sessionId: "session-2", lastModified: 1_700_000_100_000 },
  ];
  const messages = {
    "session-1": [
      { type: "user", uuid: "m1", message: { content: [{ type: "text", text: secret }] } },
      { type: "assistant", uuid: "m2", message: { content: [{ type: "tool_use", name: "Read", input: { path: secret } }] } },
    ],
    "session-2": [
      { type: "user", uuid: "m3", message: { content: [{ type: "text", text: "synthetic" }] } },
    ],
  } as const;
  let messageReadCount = 0;
  const api: ClaudeHistoryApi = {
    async listSessions(options) {
      const offset = options?.offset ?? 0;
      const limit = options?.limit ?? sessions.length;
      return sessions.slice(offset, offset + limit);
    },
    async getSessionMessages(sessionId, options) {
      messageReadCount += 1;
      const all = messages[sessionId as keyof typeof messages] ?? [];
      const offset = options?.offset ?? 0;
      return all.slice(offset, offset + (options?.limit ?? all.length));
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-claude-collector-"));
  try {
    let sequence = 0;
    const run = () => collectClaudeHistory(api, discovery, {
      dataDirectory: directory,
      jsonOutputPath: join(directory, "output.json"),
      pageSize: 2,
      maxPages: 1,
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      randomId: () => `id-${++sequence}`,
    });
    const first = await run();
    const messageReadsAfterFirstRun = messageReadCount;
    const second = await run();
    assert.equal(first.sessions.returned, 2);
    assert.equal(first.sessions.revisionsCreated, 2);
    assert.equal(second.sessions.revisionsCreated, 0);
    assert.equal(second.sessions.revisionsUnchanged, 2);
    assert.equal(first.sessions.partialMessageViews, 1);
    assert.equal(second.sessions.partialMessageViews, 1);
    assert.equal(second.coverage, "PARTIAL_PAGINATION");
    assert.equal(messageReadCount, messageReadsAfterFirstRun);
    assert.deepEqual(second.metrics.filter((item) => item.availability === "AVAILABLE")
      .map((item) => [item.key, item.value]), [
      ["session.count", 2],
    ]);
    assert.deepEqual(second.metrics.filter((item) => item.availability === "PARTIAL")
      .map((item) => [item.key, item.value]), [
      ["message.count", 3],
      ["tool.invocation.count", 1],
    ]);
    const assertions = second.metrics.find((item) => item.key === "agent.assertion.count");
    assert.equal(assertions?.value, null);
    assert.equal(assertions?.availability, "NOT_SUPPORTED");
    const output = await readFile(join(directory, "output.json"), "utf8");
    assert.equal(output.includes(secret), false);
    assert.equal((await stat(join(directory, "axtory.sqlite3"))).mode & 0o777, 0o600);
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    try {
      assert.equal(database.count("collection_runs"), 2);
      assert.equal(database.count("source_revisions"), 2);
      assert.equal(database.count("raw_observations"), 2);
      assert.equal(database.count("analysis_runs"), 2);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a session modified during collection is not reported as complete", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-claude-active-"));
  try {
    const api: ClaudeHistoryApi = {
      async listSessions(options) {
        return (options?.offset ?? 0) === 0
          ? [{ sessionId: "active-session", lastModified: 100 }]
          : [];
      },
      async getSessionMessages() {
        return [{ type: "user", uuid: "active-message", message: { content: [] } }];
      },
      async getSessionInfo() {
        return { sessionId: "active-session", lastModified: 200 };
      },
    };
    let sequence = 0;
    const output = await collectClaudeHistory(api, discovery, {
      dataDirectory: directory,
      jsonOutputPath: join(directory, "output.json"),
      pageSize: 10,
      randomId: () => `active-${++sequence}`,
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    assert.equal(output.coverage, "PARTIAL_SOURCE_CHANGED");
    assert.equal(output.sessions.sourceChangedViews, 1);
    assert.equal(output.metrics.find((item) => item.key === "message.count")?.availability, "PARTIAL");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
