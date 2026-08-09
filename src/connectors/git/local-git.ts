import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { sha256 } from "../../core/canonical-json.js";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maximumBytes: number },
) => Promise<GitCommandResult>;

export const runGitCommand: GitCommandRunner = (executable, args, options) => new Promise((resolvePromise) => {
  execFile(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: options.maximumBytes,
    encoding: "utf8",
  }, (error, stdout, stderr) => {
    const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
    resolvePromise({ stdout, stderr, exitCode });
  });
});

export interface GitCommitSnapshot {
  objectId: string;
  parentObjectIds: readonly string[];
  treeObjectId: string;
  authoredAt: string;
  committedAt: string;
}

export interface LocalGitSnapshot {
  schemaVersion: "axtory.local-git-snapshot.v1";
  repositoryIdentity: string;
  headObjectId: string | null;
  worktreeStateDigest: string;
  dirty: boolean;
  commits: readonly GitCommitSnapshot[];
}

async function invoke(
  runner: GitCommandRunner,
  repositoryDirectory: string,
  args: readonly string[],
  allowFailure = false,
): Promise<GitCommandResult> {
  const result = await runner("git", ["--no-optional-locks", "-C", repositoryDirectory, ...args], {
    cwd: repositoryDirectory,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    timeoutMs: 15_000,
    maximumBytes: 16 * 1024 * 1024,
  });
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(`local Git read failed with exit code ${result.exitCode}`);
  }
  return result;
}

function parseCommits(output: string): GitCommitSnapshot[] {
  return output.split("\u001e").flatMap((record) => {
    const trimmed = record.trim();
    if (!trimmed) return [];
    const fields = trimmed.split("\u001f");
    if (fields.length !== 5 || fields.some((value) => value === undefined)) {
      throw new Error("local Git returned an invalid commit record");
    }
    const [objectId, parents, treeObjectId, authoredAt, committedAt] = fields as
      [string, string, string, string, string];
    if (!/^[0-9a-f]{40,64}$/u.test(objectId) || !/^[0-9a-f]{40,64}$/u.test(treeObjectId) ||
      !Number.isFinite(Date.parse(authoredAt)) || !Number.isFinite(Date.parse(committedAt))) {
      throw new Error("local Git returned invalid commit metadata");
    }
    const parentObjectIds = parents ? parents.split(" ") : [];
    if (parentObjectIds.some((parent) => !/^[0-9a-f]{40,64}$/u.test(parent))) {
      throw new Error("local Git returned an invalid parent object id");
    }
    return [{ objectId, parentObjectIds, treeObjectId, authoredAt, committedAt }];
  });
}

export async function readLocalGitSnapshot(options: {
  repositoryDirectory: string;
  maximumCommits?: number;
  runner?: GitCommandRunner;
}): Promise<LocalGitSnapshot> {
  const maximumCommits = options.maximumCommits ?? 100;
  if (!Number.isInteger(maximumCommits) || maximumCommits < 1 || maximumCommits > 10_000) {
    throw new Error("maximum Git commits must be between 1 and 10000");
  }
  const runner = options.runner ?? runGitCommand;
  const requestedDirectory = resolve(options.repositoryDirectory);
  const rootResult = await invoke(runner, requestedDirectory, ["rev-parse", "--show-toplevel"]);
  const repositoryRoot = resolve(rootResult.stdout.trim());
  if (!repositoryRoot) throw new Error("local Git did not return a repository root");
  const [head, status, history] = await Promise.all([
    invoke(runner, repositoryRoot, ["rev-parse", "--verify", "HEAD"], true),
    invoke(runner, repositoryRoot, ["status", "--porcelain=v2", "-z", "--untracked-files=no"]),
    invoke(runner, repositoryRoot, ["log", `-${maximumCommits}`, "--format=%H%x1f%P%x1f%T%x1f%aI%x1f%cI%x1e"], true),
  ]);
  if (head.exitCode !== 0 && history.exitCode === 0 && history.stdout.trim()) {
    throw new Error("local Git returned history without a valid HEAD");
  }
  return {
    schemaVersion: "axtory.local-git-snapshot.v1",
    repositoryIdentity: sha256(repositoryRoot),
    headObjectId: head.exitCode === 0 ? head.stdout.trim() : null,
    worktreeStateDigest: sha256(status.stdout),
    dirty: status.stdout.length > 0,
    commits: history.exitCode === 0 ? parseCommits(history.stdout) : [],
  };
}
