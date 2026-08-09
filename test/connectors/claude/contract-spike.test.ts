import test from "node:test";
import assert from "node:assert/strict";

import {
  assertSanitizedReport,
  runClaudeContractSpike,
} from "../../../src/connectors/claude/contract-spike.js";
import type { ClaudeHistoryApi } from "../../../src/connectors/claude/history-api.js";

test("contract report keeps structure and excludes sensitive values and identifiers", async () => {
  const secret = "SUPER-SECRET-PROMPT";
  const api: ClaudeHistoryApi = {
    async listSessions() {
      return [{
        sessionId: "session-private-id",
        summary: secret,
        firstPrompt: secret,
        cwd: "/private/company/project",
        gitBranch: "secret-branch",
        lastModified: 123,
        fileSize: 456,
        createdAt: 100,
        [secret]: "untrusted-field-name",
      }];
    },
    async getSessionMessages() {
      return [
        {
          type: "user",
          uuid: "message-private-id",
          session_id: "session-private-id",
          message: { role: "user", content: [{ type: "text", text: secret }] },
          parent_tool_use_id: null,
          [secret]: true,
        },
        {
          type: "assistant",
          uuid: "message-2",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-secret", input: { token: secret } },
              { type: "tool_result", content: secret },
            ],
          },
          parent_tool_use_id: "parent-secret-id",
        },
      ];
    },
  };
  const report = await runClaudeContractSpike(api, {
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });
  assertSanitizedReport(report);
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("session-private-id"), false);
  assert.equal(encoded.includes("message-private-id"), false);
  assert.equal(encoded.includes("parent-secret-id"), false);
  assert.deepEqual(report.sessions[0]?.contentBlockTypes, {
    text: 1,
    tool_use: 1,
    tool_result: 1,
  });
  assert.equal(report.sessions[0]?.parentLinkCount, 1);
  assert.deepEqual(report.sessions[0]?.metadataFields, ["createdAt", "fileSize", "lastModified"]);
});

test("limits are represented as partial coverage rather than complete", async () => {
  const api: ClaudeHistoryApi = {
    async listSessions() {
      return [{ sessionId: "one" }];
    },
    async getSessionMessages() {
      return [{ type: "user", message: { content: [] } }];
    },
  };
  const report = await runClaudeContractSpike(api, { sessionLimit: 1, messageLimit: 1 });
  assert.equal(report.sessionCoverage, "PARTIAL_LIMIT");
  assert.equal(report.sessions[0]?.coverage, "PARTIAL_LIMIT");
});
