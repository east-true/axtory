import test from "node:test";
import assert from "node:assert/strict";

import { listAllMessages, listAllSessions } from "../../../src/connectors/claude/pagination.js";
import type { ClaudeHistoryApi } from "../../../src/connectors/claude/history-api.js";

test("session pagination preserves source order and stops on a short page", async () => {
  const offsets: number[] = [];
  const api: ClaudeHistoryApi = {
    async listSessions(options) {
      offsets.push(options?.offset ?? -1);
      const all = ["s1", "s2", "s3"].map((sessionId) => ({ sessionId }));
      return all.slice(options?.offset ?? 0, (options?.offset ?? 0) + (options?.limit ?? all.length));
    },
    async getSessionMessages() { return []; },
  };
  const result = await listAllSessions(api, { pageSize: 2 });
  assert.deepEqual(result.items.map((item) => item.sessionId), ["s1", "s2", "s3"]);
  assert.deepEqual(offsets, [0, 2]);
  assert.equal(result.coverage, "COMPLETE_FOR_RETURNED_VIEW");
});

test("page overlap is deduplicated but marks coverage partial", async () => {
  const api: ClaudeHistoryApi = {
    async listSessions() { return []; },
    async getSessionMessages(_sessionId, options) {
      if (options?.offset === 0) return [{ type: "user", uuid: "m1" }, { type: "assistant", uuid: "m2" }];
      return [{ type: "assistant", uuid: "m2" }];
    },
  };
  const result = await listAllMessages(api, "session", { pageSize: 2 });
  assert.deepEqual(result.items.map((item) => item.uuid), ["m1", "m2"]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.coverage, "PARTIAL_PAGINATION");
});

test("max page guard never claims completeness", async () => {
  const api: ClaudeHistoryApi = {
    async listSessions(options) {
      const offset = options?.offset ?? 0;
      return [{ sessionId: `s${offset}` }, { sessionId: `s${offset + 1}` }];
    },
    async getSessionMessages() { return []; },
  };
  const result = await listAllSessions(api, { pageSize: 2, maxPages: 2 });
  assert.equal(result.items.length, 4);
  assert.equal(result.coverage, "PARTIAL_PAGINATION");
});
