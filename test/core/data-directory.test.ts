import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureAxtoryDataDirectory, purgeAxtoryDataDirectory } from "../../src/core/data-directory.js";

test("purge requires both explicit confirmation and an AXtory marker", async () => {
  const parent = await mkdtemp(join(tmpdir(), "axtory-purge-test-"));
  const data = join(parent, "data");
  try {
    await ensureAxtoryDataDirectory(data);
    await writeFile(join(data, "sensitive-local-data"), "synthetic", { mode: 0o600 });
    await assert.rejects(purgeAxtoryDataDirectory(data, "NO"), /PURGE_ALL/u);
    await purgeAxtoryDataDirectory(data, "PURGE_ALL");
    await assert.rejects(access(data));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("an unrelated non-empty directory cannot be converted into a purge target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-unrelated-directory-"));
  try {
    await writeFile(join(directory, "unrelated-user-file"), "keep", { mode: 0o600 });
    await assert.rejects(
      ensureAxtoryDataDirectory(directory),
      /contains non-AXtory files/u,
    );
    await assert.rejects(
      purgeAxtoryDataDirectory(directory, "PURGE_ALL"),
      /valid AXtory marker|ENOENT/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
