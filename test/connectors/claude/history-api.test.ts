import test from "node:test";
import assert from "node:assert/strict";

import { loadClaudeHistoryApi } from "../../../src/connectors/claude/history-api.js";

test("missing official SDK is reported explicitly", async () => {
  await assert.rejects(
    loadClaudeHistoryApi(async () => {
      throw new Error("module not found");
    }),
    /official Claude Agent SDK is not installed/u,
  );
});

test("an incompatible SDK is not silently accepted", async () => {
  await assert.rejects(
    loadClaudeHistoryApi(async () => ({ listSessions: async () => [] })),
    /does not expose the documented history read API/u,
  );
});

test("documented history functions are exposed through the adapter", async () => {
  const listSessions = async () => [];
  const getSessionMessages = async () => [];
  const getSessionInfo = async () => undefined;
  const api = await loadClaudeHistoryApi(async () => ({ listSessions, getSessionMessages, getSessionInfo }));
  assert.equal(api.listSessions, listSessions);
  assert.equal(api.getSessionMessages, getSessionMessages);
  assert.equal(api.getSessionInfo, getSessionInfo);
});
