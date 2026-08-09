import test from "node:test";
import assert from "node:assert/strict";

import { normalizeClaudeSession } from "../../../src/connectors/claude/normalizer.js";

test("official history normalization keeps time quality and occurrence identity explicit", () => {
  const observations = normalizeClaudeSession(
    { sessionId: "private-session", createdAt: Date.parse("2026-01-01T00:00:00Z") },
    [{
      type: "assistant",
      uuid: "private-message",
      timestamp: "2026-01-01T00:00:01Z",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { path: "private.txt" } },
          { type: "tool_use", name: "Read", input: { path: "private.txt" } },
        ],
      },
      parent_tool_use_id: "private-parent-tool",
    }],
    "revision",
    "COMPLETE_FOR_RETURNED_VIEW",
  );
  const message = observations.find((item) => item.kind === "CONTENT");
  const tools = observations.filter((item) => item.stableKey.startsWith("tool-occurrence:"));
  assert.equal(message?.occurredAt, "2026-01-01T00:00:01.000Z");
  assert.equal(message?.timeQuality, "SOURCE_REPORTED");
  assert.equal(tools.length, 2);
  assert.equal(tools[0]?.payload.contentIdentity, tools[1]?.payload.contentIdentity);
  assert.notEqual(tools[0]?.payload.usageOccurrenceId, tools[1]?.payload.usageOccurrenceId);
  assert.equal(JSON.stringify(observations).includes("private.txt"), false);
  assert.equal(JSON.stringify(observations).includes("private-session"), false);
});

test("collector time is not substituted when source timestamp is absent", () => {
  const observations = normalizeClaudeSession(
    { sessionId: "session" },
    [{ type: "user", uuid: "message", message: { content: [] } }],
    "revision",
    "COMPLETE_FOR_RETURNED_VIEW",
  );
  const message = observations.find((item) => item.kind === "CONTENT");
  assert.equal(message?.occurredAt, null);
  assert.equal(message?.timeQuality, "ORDER_ONLY");
});
