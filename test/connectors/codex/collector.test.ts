import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectCodexHistory } from "../../../src/connectors/codex/collector.js";
import { CodexRequestError } from "../../../src/connectors/codex/app-server.js";
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

test("a turn that never completed keeps the view partial", async () => {
  // App Server reports an interrupted or still-running turn with completedAt null and status
  // "interrupted"; the isolated snapshot read cannot tell the two apart and must not call either
  // view complete.
  const detail = thread("synthetic");
  detail.turns[0]!.status = "interrupted";
  detail.turns[0]!.completedAt = null;
  const api: CodexThreadApi = {
    async listThreads(params) {
      return params.archived ? { data: [], nextCursor: null } : { data: [{ ...detail, turns: [] }], nextCursor: null };
    },
    async readThread() { return detail; },
    async close() {},
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-unsettled-"));
  try {
    let sequence = 0;
    const output = await collectCodexHistory(api, discovery, {
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"),
      randomId: () => `unsettled-${++sequence}`,
    });
    assert.equal(output.coverage, "PARTIAL_UNSETTLED_TURN");
    assert.equal(output.threads.unsettledTurnViews, 1);
    assert.equal(output.threads.activeViews, 0, "status never says active through a snapshot read");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a completed turn is still reported complete", async () => {
  const detail = thread("synthetic");
  const api: CodexThreadApi = {
    async listThreads(params) {
      return params.archived ? { data: [], nextCursor: null } : { data: [{ ...detail, turns: [] }], nextCursor: null };
    },
    async readThread() { return detail; },
    async close() {},
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-settled-"));
  try {
    let sequence = 0;
    const output = await collectCodexHistory(api, discovery, {
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"),
      randomId: () => `settled-${++sequence}`,
    });
    assert.equal(output.coverage, "COMPLETE_FOR_RETURNED_VIEW");
    assert.equal(output.threads.unsettledTurnViews, 0);
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

test("a refused thread is partial coverage, not a discarded run", async () => {
  // One thread the App Server declines must not cost the caller the threads it did read.
  const readable = { ...thread("READABLE"), id: "thread-ok" };
  const api: CodexThreadApi = {
    async listThreads(params) {
      return params.archived
        ? { data: [], nextCursor: null }
        : {
          data: [
            { ...readable, turns: [] },
            { ...thread("REFUSED"), id: "thread-refused", turns: [] },
          ],
          nextCursor: null,
        };
    },
    async readThread(threadId) {
      if (threadId === "thread-refused") {
        throw new CodexRequestError(
          "Codex App Server request failed with code -32600: paginated threads do not support " +
            "thread/read(includeTurns=true)",
          -32600,
        );
      }
      return readable;
    },
    async close() {},
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-unreadable-"));
  try {
    const output = await collectCodexHistory(api, discovery, {
      dataDirectory: directory, jsonOutputPath: join(directory, "out.json"),
      now: () => new Date("2026-03-01T00:00:00.000Z"), randomId: () => "fixed",
    });
    assert.equal(output.coverage, "PARTIAL_UNREADABLE_THREAD");
    assert.equal(output.threads.unreadableThreads, 1);
    assert.equal(output.threads.revisionsCreated, 1, "the readable thread must still be collected");
    assert.match(output.threads.unreadableReasons[0]!, /paginated threads do not support/u);
    // The refusal explains itself in the export, but carries no conversation content.
    const written = await readFile(join(directory, "out.json"), "utf8");
    assert.equal(written.includes("REFUSED"), false);
    assert.equal(written.includes("thread-refused"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unhealthy channel still aborts instead of reporting silence as coverage", async () => {
  // A dead or desynchronized server answers nothing. Stepping past that would keep questioning it
  // and report the resulting emptiness as a successful partial run.
  const api: CodexThreadApi = {
    async listThreads(params) {
      return params.archived
        ? { data: [], nextCursor: null }
        : { data: [{ ...thread("X"), turns: [] }], nextCursor: null };
    },
    async readThread() {
      throw new Error("Codex App Server returned invalid NDJSON");
    },
    async close() {},
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-broken-"));
  try {
    await assert.rejects(
      collectCodexHistory(api, discovery, {
        dataDirectory: directory, jsonOutputPath: join(directory, "out.json"),
      }),
      /invalid NDJSON/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
