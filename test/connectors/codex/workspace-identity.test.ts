import test from "node:test";
import assert from "node:assert/strict";

import { sha256 } from "../../../src/core/canonical-json.js";
import { normalizeClaudeSession } from "../../../src/connectors/claude/normalizer.js";
import { normalizeCodexThread } from "../../../src/connectors/codex/normalizer.js";
import type { CodexThread } from "../../../src/connectors/codex/types.js";

const WORKSPACE = "/home/someone/shared-project";

function thread(overrides: Partial<CodexThread>): CodexThread {
  return {
    id: "thread", sessionId: "session", forkedFromId: null, parentThreadId: null, preview: "",
    ephemeral: false, modelProvider: "openai", createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
    recencyAt: null, status: { type: "idle" }, path: null, cwd: WORKSPACE, cliVersion: "0.147.0",
    source: "cli", threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
    name: null, turns: [],
    ...overrides,
  };
}

function sessionPayload(observations: readonly { stableKey: string; payload: Record<string, unknown> }[]) {
  const session = observations.find((item) => item.stableKey === "session");
  assert.ok(session, "a session observation is expected");
  return session.payload;
}

test("a Codex thread records its workspace and branch as digests", () => {
  const payload = sessionPayload(normalizeCodexThread(
    thread({ gitInfo: { sha: "abc", branch: "feature/x", originUrl: "git@example.com:o/r.git" } }),
    "revision",
    "COMPLETE_FOR_RETURNED_VIEW",
  ));
  assert.equal(payload.workspaceIdentity, sha256(WORKSPACE));
  assert.equal(payload.branchIdentity, sha256("feature/x"));
});

test("a Codex thread outside a Git working tree records a workspace but no branch", () => {
  // App Server reports gitInfo null for such a thread. An absent branch is a normal thread rather
  // than a collection gap, so the key is omitted instead of carrying a digest of nothing.
  const payload = sessionPayload(normalizeCodexThread(thread({}), "revision", "COMPLETE_FOR_RETURNED_VIEW"));
  assert.equal(payload.workspaceIdentity, sha256(WORKSPACE));
  assert.equal("branchIdentity" in payload, false);
});

test("a Codex thread whose gitInfo omits a branch records no branch", () => {
  // Observed on 8 of 16 real threads that carried gitInfo: sha and originUrl present, branch null.
  const payload = sessionPayload(normalizeCodexThread(
    thread({ gitInfo: { sha: "abc", branch: null, originUrl: "git@example.com:o/r.git" } }),
    "revision",
    "COMPLETE_FOR_RETURNED_VIEW",
  ));
  assert.equal("branchIdentity" in payload, false);
});

test("Claude and Codex derive the same workspace digest from the same directory", () => {
  // The point of the shared rule: one --workspace-dir must select a directory's sessions from both
  // sources, which only holds if both hash the same absolute path the same way.
  const codex = sessionPayload(normalizeCodexThread(thread({}), "revision", "COMPLETE_FOR_RETURNED_VIEW"));
  const claude = sessionPayload(normalizeClaudeSession(
    {
      sessionId: "claude-session", createdAt: 1_700_000_000, lastModified: 1_700_000_100,
      cwd: WORKSPACE, gitBranch: "feature/x",
    } as never,
    [],
    "revision",
    "COMPLETE_FOR_RETURNED_VIEW",
  ));
  assert.equal(codex.workspaceIdentity, claude.workspaceIdentity);
});
