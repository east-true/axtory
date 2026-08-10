import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSanitizedCodexReport,
  runCodexContractSpike,
} from "../../../src/connectors/codex/contract-spike.js";
import type { CodexThread, CodexThreadApi } from "../../../src/connectors/codex/types.js";

test("Codex contract report retains structure but excludes sensitive values", async () => {
  const secret = "PRIVATE-CODEX-SPIKE";
  const detail: CodexThread = {
    id: "private-thread", sessionId: "private-session", forkedFromId: "private-fork",
    parentThreadId: "private-parent", preview: secret, ephemeral: false, modelProvider: secret,
    createdAt: 1, updatedAt: 2, recencyAt: null, status: { type: "idle" }, path: `/private/${secret}`,
    cwd: `/private/${secret}`, cliVersion: "1.0.0", source: "appServer", threadSource: null,
    agentNickname: secret, agentRole: secret, gitInfo: { branch: secret }, name: secret,
    turns: [{ id: "private-turn", itemsView: "full", status: "completed", startedAt: 1,
      completedAt: 2, durationMs: 1, items: [{ type: "agentMessage", id: "private-item", text: secret }] }],
  };
  const api: CodexThreadApi = {
    async listThreads(params) {
      return params.archived ? { data: [], nextCursor: null } : { data: [{ ...detail, turns: [] }], nextCursor: null };
    },
    async readThread() { return detail; },
    async close() {},
  };
  const report = await runCodexContractSpike(api, { now: () => new Date("2026-08-09T00:00:00.000Z") });
  assertSanitizedCodexReport(report);
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("private-thread"), false);
  assert.equal(report.forkLinkCount, 1);
  assert.equal(report.parentLinkCount, 1);
  assert.deepEqual(report.itemTypes, { agentMessage: 1 });
});
