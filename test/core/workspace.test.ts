import test from "node:test";
import assert from "node:assert/strict";

import { namedBranch, namedWorkspace } from "../../src/core/workspace.js";

test("the literal HEAD is not a branch name", () => {
  // Git reports HEAD when nothing is checked out, and Claude reports it for a directory that is not
  // a repository. Treating it as a branch would give every unrelated session in that state one
  // shared identity, so it must read as no branch.
  assert.equal(namedBranch("HEAD"), null);
  assert.equal(namedBranch("main"), "main");
  assert.equal(namedBranch("feature/HEAD"), "feature/HEAD", "only the exact string is a placeholder");
  assert.equal(namedBranch(""), null);
  assert.equal(namedBranch(null), null);
  assert.equal(namedBranch(42), null);
});

test("a workspace is any non-empty directory string", () => {
  assert.equal(namedWorkspace("/home/someone/project"), "/home/someone/project");
  assert.equal(namedWorkspace(""), null);
  assert.equal(namedWorkspace(undefined), null);
});
