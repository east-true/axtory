import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectCodexHistory } from "../../../src/connectors/codex/collector.js";
import type { CodexDiscovery } from "../../../src/connectors/codex/discovery.js";
import type { CodexThread, CodexThreadApi } from "../../../src/connectors/codex/types.js";
import { AxtoryDatabase } from "../../../src/core/storage.js";
import { runRuleSemanticAnalysis } from "../../../src/analysis/semantic-pipeline.js";

const discovery: CodexDiscovery = {
  environment: {
    id: "environment", type: "LINUX", os: "linux", architecture: "x64",
    homeDirectory: { status: "AVAILABLE", value: "/synthetic-home" },
  },
  sourceProfile: {
    id: "profile", sourceType: "CODEX", environmentId: "environment",
    dataRoot: { status: "AVAILABLE", value: "/synthetic-home/.codex" },
    executablePath: { status: "AVAILABLE", value: "/synthetic-bin/codex" },
    activeVersion: { status: "AVAILABLE", value: "1.2.3" },
  },
  capabilityAssessment: {
    sourceProfileId: "profile", assessedAt: "2026-08-09T00:00:00.000Z",
    capabilities: [
      { key: "codex.installation", availability: "AVAILABLE", evidence: ["synthetic"] },
      { key: "codex.state", availability: "AVAILABLE", evidence: ["synthetic"] },
      { key: "codex.login", availability: "AVAILABLE", evidence: ["synthetic"] },
    ],
  },
};

function thread(secret: string): CodexThread {
  return {
    id: "thread-private", sessionId: "session-private", forkedFromId: null, parentThreadId: null,
    preview: secret, ephemeral: false, modelProvider: "openai", createdAt: 1_700_000_000,
    updatedAt: 1_700_000_100, recencyAt: null, status: { type: "idle" }, path: "/private/rollout",
    cwd: "/private/project", cliVersion: "1.2.3", source: "exec", threadSource: null,
    agentNickname: null, agentRole: null, gitInfo: null, name: secret,
    turns: [{
      id: "turn-private", itemsView: "full", status: "completed", startedAt: 1_700_000_001,
      completedAt: 1_700_000_002, durationMs: 1_000,
      items: [
        { type: "userMessage", id: "u", content: [{ type: "text", text: secret }] },
        { type: "agentMessage", id: "a", text: secret },
        { type: "webSearch", id: "w", query: secret },
      ],
    }],
  };
}

test("Codex collector is incremental and exports no content", async () => {
  const secret = "PRIVATE-CODEX-PROMPT";
  const detail = thread(secret);
  let reads = 0;
  const api: CodexThreadApi = {
    async listThreads(params) {
      return params.archived
        ? { data: [], nextCursor: null }
        : { data: [{ ...detail, turns: [] }], nextCursor: null };
    },
    async readThread() { reads += 1; return detail; },
    async close() {},
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-collector-"));
  try {
    let sequence = 0;
    const run = () => collectCodexHistory(api, discovery, {
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"),
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => `id-${++sequence}`,
    });
    const first = await run();
    const second = await run();
    assert.equal(first.threads.revisionsCreated, 1);
    assert.equal(second.threads.revisionsCreated, 0);
    assert.equal(second.threads.revisionsUnchanged, 1);
    assert.equal(reads, 1);
    assert.deepEqual(second.metrics.filter((item) => item.availability === "AVAILABLE")
      .map((item) => [item.key, item.value]), [
      ["session.count", 1], ["message.count", 2], ["tool.invocation.count", 1],
    ]);
    assert.equal((await readFile(join(directory, "output.json"), "utf8")).includes(secret), false);
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    let revisionId: string;
    try {
      assert.equal(database.count("source_revisions"), 1);
      assert.equal(database.count("raw_observations"), 1);
      revisionId = database.inventory().sources[0]!.revisions[0]!.revisionId;
    } finally {
      database.close();
    }
    const semantic = await runRuleSemanticAnalysis({
      dataDirectory: directory, revisionId, allowConversationContent: true,
      randomId: () => "codex-semantic", now: () => new Date("2026-08-09T01:00:00.000Z"),
    });
    assert.equal(semantic.documentsAnalyzed, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("active Codex threads are reread and remain partial", async () => {
  const detail = thread("synthetic");
  detail.status = { type: "active" };
  let reads = 0;
  const api: CodexThreadApi = {
    async listThreads(params) {
      return params.archived ? { data: [], nextCursor: null } : { data: [{ ...detail, turns: [] }], nextCursor: null };
    },
    async readThread() { reads += 1; return detail; },
    async close() {},
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-active-"));
  try {
    let sequence = 0;
    const run = () => collectCodexHistory(api, discovery, {
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"),
      randomId: () => `active-${++sequence}`,
    });
    assert.equal((await run()).coverage, "PARTIAL_SOURCE_CHANGED");
    assert.equal((await run()).coverage, "PARTIAL_SOURCE_CHANGED");
    assert.equal(reads, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
