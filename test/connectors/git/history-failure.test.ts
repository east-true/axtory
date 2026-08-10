import test from "node:test";
import assert from "node:assert/strict";

import { readLocalGitSnapshot, type GitCommandRunner } from "../../../src/connectors/git/local-git.js";

function runner(responses: Record<string, { stdout?: string; exitCode?: number }>): GitCommandRunner {
  return async (_executable, args) => {
    const subcommand = args.find((value) => ["rev-parse", "status", "log"].includes(value)) ?? "";
    const key = subcommand === "rev-parse" && args.includes("--show-toplevel") ? "toplevel" : subcommand;
    const response = responses[key] ?? {};
    return { stdout: response.stdout ?? "", stderr: "", exitCode: response.exitCode ?? 0 };
  };
}

test("a failed history read is an error, not a repository with zero commits", async () => {
  // Truncated output or a timeout makes `git log` exit non-zero. HEAD resolving proves commits
  // exist, so reporting an empty history would coerce an uncollected value to zero.
  await assert.rejects(() => readLocalGitSnapshot({
    repositoryDirectory: "/synthetic/repository",
    runner: runner({
      toplevel: { stdout: "/synthetic/repository\n" },
      status: { stdout: "" },
      log: { exitCode: 1 },
    }),
  }), /log failed with exit code 1 for a repository with a valid HEAD/u);
});

test("a repository with no commits still reads as an empty history", async () => {
  const snapshot = await readLocalGitSnapshot({
    repositoryDirectory: "/synthetic/repository",
    runner: runner({
      toplevel: { stdout: "/synthetic/repository\n" },
      status: { stdout: "" },
      // Without any commit, both HEAD and log fail; that is a legitimately empty repository.
      "rev-parse": { exitCode: 128 },
      log: { exitCode: 128 },
    }),
  });
  assert.deepEqual(snapshot.commits, []);
  assert.equal(snapshot.headObjectId, null);
});
