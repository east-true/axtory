/**
 * Workspace context shared by every connector that reports where a session ran.
 *
 * Both the directory and the branch are path- and name-bearing, so only digests reach a canonical
 * observation. Keeping the rule here means each connector hashes the same value the same way, which
 * is what lets one workspace scope select sessions recorded by different providers.
 */

/**
 * Git reports the literal `HEAD` when no branch is checked out, and Claude reports the same string
 * for a directory that is not a repository at all. Hashing it would give every unrelated session in
 * that state one shared branch identity and would count it as a distinct branch, so it is treated as
 * no branch. Git refuses to create a branch named `HEAD`, so no real branch is lost.
 */
export function namedBranch(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value !== "HEAD" ? value : null;
}

/** An absolute directory a session ran in, or null when the source reports none. */
export function namedWorkspace(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
