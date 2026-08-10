import test from "node:test";
import assert from "node:assert/strict";

import { listAllCodexThreads } from "../../../src/connectors/codex/pagination.js";
import { CODEX_THREAD_SOURCE_KINDS, type CodexThread, type CodexThreadApi } from "../../../src/connectors/codex/types.js";

function thread(id: string): CodexThread {
  return {
    id, sessionId: `session-${id}`, forkedFromId: null, parentThreadId: null, preview: "", ephemeral: false,
    modelProvider: "openai", createdAt: 1, updatedAt: 2, recencyAt: 2, status: { type: "idle" }, path: null,
    cwd: "/private", cliVersion: "0.1.0", source: "cli", threadSource: null, agentNickname: null,
    agentRole: null, gitInfo: null, name: null, turns: [],
  };
}

test("Codex pagination includes archived and non-interactive sources without metadata repair", async () => {
  const calls: Parameters<CodexThreadApi["listThreads"]>[0][] = [];
  const api: CodexThreadApi = {
    async listThreads(params) {
      calls.push(params);
      if (params.archived) return { data: [thread("archived")], nextCursor: null };
      if (!params.cursor) return { data: [thread("one")], nextCursor: "next" };
      return { data: [thread("two")], nextCursor: null };
    },
    async readThread() { throw new Error("not used"); },
    async close() {},
  };
  const result = await listAllCodexThreads(api, { pageSize: 1 });
  assert.deepEqual(result.items.map((item) => item.id), ["one", "two", "archived"]);
  assert.equal(result.coverage, "COMPLETE_FOR_RETURNED_VIEW");
  assert.equal(calls.every((call) => call.useStateDbOnly === true), true);
  assert.equal(calls.every((call) => call.sourceKinds?.length === CODEX_THREAD_SOURCE_KINDS.length), true);
  assert.deepEqual(new Set(calls.map((call) => call.archived)), new Set([false, true]));
});

test("a repeated cursor and duplicate identity produce partial coverage", async () => {
  const api: CodexThreadApi = {
    async listThreads(params) {
      if (params.archived) return { data: [], nextCursor: null };
      return { data: [thread("same")], nextCursor: "loop" };
    },
    async readThread() { throw new Error("not used"); },
    async close() {},
  };
  const result = await listAllCodexThreads(api);
  assert.equal(result.coverage, "PARTIAL_PAGINATION");
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.items.length, 1);
});
