import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureAxtoryDataDirectory, purgeAxtoryDataDirectory } from "../../src/core/data-directory.js";

test("concurrent initialization creates one valid marker without rejecting peer callers", async () => {
  const parent = await mkdtemp(join(tmpdir(), "axtory-data-directory-race-"));
  const data = join(parent, "data");
  try {
    const resolved = await Promise.all(Array.from(
      { length: 16 },
      () => ensureAxtoryDataDirectory(data),
    ));
    assert.equal(new Set(resolved).size, 1);
    assert.deepEqual((await readdir(data)).sort(), [".axtory-data-directory"]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("purge refuses a data directory that contains the active working directory", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "axtory-purge-ancestor-"));
  const data = join(parent, "data");
  const nestedWorkingDirectory = join(data, "work", "nested");
  try {
    await ensureAxtoryDataDirectory(data);
    await mkdir(nestedWorkingDirectory, { recursive: true });
    context.mock.method(process, "cwd", () => nestedWorkingDirectory);

    await assert.rejects(
      purgeAxtoryDataDirectory(data, "PURGE_ALL"),
      /broad or protected directory/u,
    );
    await access(data);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a symlinked data path resolves to and purges the actual data directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "axtory-symlinked-data-directory-"));
  const actual = join(parent, "actual");
  const alias = join(parent, "alias");
  try {
    await mkdir(actual, { mode: 0o700 });
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    const canonical = await realpath(actual);
    assert.equal(await ensureAxtoryDataDirectory(alias), canonical);
    await writeFile(join(actual, "sensitive-local-data"), "synthetic", { mode: 0o600 });

    await purgeAxtoryDataDirectory(alias, "PURGE_ALL");

    await assert.rejects(access(actual));
    await assert.rejects(access(alias));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
