import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCodexThread } from "../../../src/connectors/codex/normalizer.js";
import type { CodexThread } from "../../../src/connectors/codex/types.js";

test("Codex normalizer hashes content and preserves only explicit lineage", () => {
  const secret = "PRIVATE-CODEX-CONTENT";
  const value: CodexThread = {
    id: "thread-private", sessionId: "session-private", forkedFromId: "fork-private",
    parentThreadId: "parent-private", preview: secret, ephemeral: false, modelProvider: "openai",
    createdAt: 1_700_000_000, updatedAt: 1_700_000_100, recencyAt: null, status: { type: "idle" },
    path: "/private/rollout.jsonl", cwd: "/private/project", cliVersion: "1.2.3", source: "cli",
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: secret,
    turns: [{
      id: "turn-private", itemsView: "full", status: "completed", startedAt: 1_700_000_001,
      completedAt: 1_700_000_002, durationMs: 1_000,
      items: [
        { type: "userMessage", id: "user-private", content: [{ type: "text", text: secret }] },
        { type: "agentMessage", id: "agent-private", text: secret },
        { type: "commandExecution", id: "command-private", command: secret, aggregatedOutput: secret },
        { type: "contextCompaction", id: "compact-private" },
      ],
    }],
  };
  const observations = normalizeCodexThread(value, "revision", "PARTIAL_COMPACTION");
  const encoded = JSON.stringify(observations);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("/private/project"), false, "the workspace path must stay out of observations");
  assert.equal(encoded.includes("thread-private"), false);
  assert.equal(encoded.includes("fork-private"), false);
  assert.equal(encoded.includes("parent-private"), false);
  assert.equal(observations.filter((item) => item.kind === "CONTENT").length, 2);
  assert.equal(observations.filter((item) => item.stableKey.startsWith("tool-occurrence:")).length, 1);
  assert.deepEqual(observations.filter((item) => item.kind === "RELATION")
    .map((item) => item.payload.relationType), ["FORKED_FROM", "SUBAGENT_OF"]);
});
