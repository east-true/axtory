import test from "node:test";
import assert from "node:assert/strict";

import { listAllMessages, listAllSessions } from "../../../src/connectors/claude/pagination.js";
import type { ClaudeHistoryApi } from "../../../src/connectors/claude/history-api.js";

function api(overrides: Partial<ClaudeHistoryApi>): ClaudeHistoryApi {
  return {
    listSessions: async () => [],
    getSessionMessages: async () => [],
    ...overrides,
  } as ClaudeHistoryApi;
}

test("a message without the optional uuid is kept as an occurrence and reported as partial", async () => {
  const result = await listAllMessages(api({
    getSessionMessages: async (_sessionId, options) => options?.offset === 0
      ? [{ type: "user", uuid: "m1" }, { type: "system" }, { type: "assistant", uuid: "m2" }]
      : [],
  }), "session", { pageSize: 3 });

  // Dropping or rejecting the identity-less message would lose a real usage occurrence; keeping it
  // means overlap dedup could not cover it, so the returned view is partial rather than complete.
  assert.equal(result.items.length, 3);
  assert.equal(result.unidentifiedCount, 1);
  assert.equal(result.coverage, "PARTIAL_PAGINATION");
});

test("a session without its contract-guaranteed id still fails explicitly", async () => {
  await assert.rejects(
    () => listAllSessions(api({ listSessions: async () => [{ sessionId: "" }] })),
    /without identity/u,
  );
});

test("identified messages keep complete coverage and overlap deduplication", async () => {
  const result = await listAllMessages(api({
    getSessionMessages: async (_sessionId, options) => options?.offset === 0
      ? [{ type: "user", uuid: "m1" }, { type: "assistant", uuid: "m2" }]
      : [{ type: "assistant", uuid: "m2" }],
  }), "session", { pageSize: 2 });
  assert.equal(result.unidentifiedCount, 0);
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.items.map((item) => item.uuid), ["m1", "m2"]);
});
