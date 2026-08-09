import test from "node:test";
import assert from "node:assert/strict";

import { readLocalGitSnapshot, type GitCommandRunner } from "../../../src/connectors/git/local-git.js";

test("local Git reader disables prompts and optional locks and retains no path or author fields", async () => {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const oid = "a".repeat(40);
  const tree = "b".repeat(40);
  const runner: GitCommandRunner = async (_executable, args, options) => {
    calls.push({ args, env: options.env });
    const command = args.slice(3).join(" ");
    if (command === "rev-parse --show-toplevel") return { stdout: "/tmp/synthetic-repo\n", stderr: "", exitCode: 0 };
    if (command === "rev-parse --verify HEAD") return { stdout: `${oid}\n`, stderr: "", exitCode: 0 };
    if (command.startsWith("status ")) return { stdout: "1 .M N... synthetic-secret-path.ts\0", stderr: "", exitCode: 0 };
    if (command.startsWith("log ")) return {
      stdout: `${oid}\u001f\u001f${tree}\u001f2026-01-02T03:00:01Z\u001f2026-01-02T03:00:02Z\u001e`,
      stderr: "", exitCode: 0,
    };
    throw new Error(`unexpected command: ${command}`);
  };
  const snapshot = await readLocalGitSnapshot({ repositoryDirectory: "/tmp/synthetic-repo", runner });
  assert.equal(snapshot.dirty, true);
  assert.equal(snapshot.commits.length, 1);
  assert.equal(JSON.stringify(snapshot).includes("synthetic-secret-path"), false);
  assert.ok(calls.every((call) => call.args[0] === "--no-optional-locks"));
  assert.ok(calls.every((call) => call.env.GIT_OPTIONAL_LOCKS === "0" && call.env.GIT_TERMINAL_PROMPT === "0"));
});
