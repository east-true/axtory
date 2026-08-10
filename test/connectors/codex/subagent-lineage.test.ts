import test from "node:test";
import assert from "node:assert/strict";

import { normalizeCodexThread } from "../../../src/connectors/codex/normalizer.js";
import type { CodexThread } from "../../../src/connectors/codex/types.js";

// Shape observed from a bounded read of a real App Server 0.147.0 state database. A spawned
// subagent leaves the top-level `parentThreadId` null and declares its parent inside the source
// variant, while `forkedFromId` repeats that same id because spawning is implemented as a fork.
function spawnedSubagent(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-child", sessionId: "session-child", forkedFromId: "thread-parent",
    parentThreadId: null, preview: "", ephemeral: false, modelProvider: "synthetic",
    createdAt: 1_786_233_600, updatedAt: 1_786_233_600, recencyAt: null,
    status: { type: "idle" }, path: null, cwd: "/synthetic", cliVersion: "0.147.0",
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: "thread-parent", depth: 1,
          agent_path: "/synthetic/agents/reviewer.md", agent_nickname: "reviewer", agent_role: null,
        },
      },
    },
    threadSource: null, agentNickname: null, turns: [],
    ...overrides,
  } as CodexThread;
}

function relations(thread: CodexThread) {
  return normalizeCodexThread(thread, "revision-1", "COMPLETE_FOR_RETURNED_VIEW")
    .filter((item) => item.kind === "RELATION");
}

test("a spawned subagent records its declared parent from the source variant", () => {
  const found = relations(spawnedSubagent());
  assert.deepEqual(found.map((item) => item.stableKey), ["relation:subagent-of"]);
  const payload = found[0]!.payload as Record<string, unknown>;
  assert.equal(payload.relationType, "SUBAGENT_OF");
  // Identities are hashed, and the agent path and nickname beside the parent id stay out entirely.
  assert.match(String(payload.parentThreadIdentity), /^[0-9a-f]{64}$/u);
  const serialized = JSON.stringify(found);
  assert.equal(serialized.includes("thread-parent"), false);
  assert.equal(serialized.includes("reviewer"), false);
  assert.equal(serialized.includes("/synthetic/agents"), false);
});

test("a spawn is not also reported as a user fork of the same thread", () => {
  // `forkedFromId` repeats the spawn parent, so emitting FORKED_FROM too would label one link as
  // two different lineage kinds and present an agent spawn as a user fork.
  const found = relations(spawnedSubagent());
  assert.equal(found.some((item) => item.stableKey === "relation:forked-from"), false);
});

test("a fork pointing somewhere other than the spawn parent is still recorded", () => {
  const found = relations(spawnedSubagent({ forkedFromId: "thread-other" }));
  assert.deepEqual(
    found.map((item) => item.stableKey).sort(),
    ["relation:forked-from", "relation:subagent-of"],
  );
});

test("a plain fork with no subagent source keeps its fork relation", () => {
  const found = relations(spawnedSubagent({ source: "cli", forkedFromId: "thread-parent" }));
  assert.deepEqual(found.map((item) => item.stableKey), ["relation:forked-from"]);
});

test("a thread with no lineage evidence produces no relation", () => {
  const found = relations(spawnedSubagent({ source: "cli", forkedFromId: null }));
  assert.deepEqual(found, []);
});

test("a malformed source variant is ignored rather than invented", () => {
  for (const source of [null, "cli", { subAgent: null }, { subAgent: { thread_spawn: {} } },
    { subAgent: { thread_spawn: { parent_thread_id: "" } } }]) {
    const found = relations(spawnedSubagent({ source, forkedFromId: null }));
    assert.deepEqual(found, [], `source ${JSON.stringify(source)} invented a relation`);
  }
});
