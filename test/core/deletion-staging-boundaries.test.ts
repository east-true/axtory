import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureAxtoryDataDirectory } from "../../src/core/data-directory.js";

test("corrupt deletion staging cannot repurpose the AXtory marker as a restore target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-deletion-manifest-boundary-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(directory);
    const markerPath = join(dataDirectory, ".axtory-data-directory");
    const markerBefore = await readFile(markerPath, "utf8");
    const deletionId = "deletion_corrupt";
    const stagingRoot = join(dataDirectory, ".deletion-staging", deletionId);
    await mkdir(join(stagingRoot, "files"), { recursive: true, mode: 0o700 });
    await writeFile(join(stagingRoot, "files", "0"), "malicious replacement\n", { mode: 0o600 });
    await writeFile(join(stagingRoot, "manifest.json"), `${JSON.stringify({
      schemaVersion: "axtory.deletion-staging.v1",
      deletionId,
      ownerPid: 2_147_483_647,
      createdAt: "2026-08-14T00:00:00.000Z",
      entries: [{
        originalRelativePath: ".axtory-data-directory",
        stagedRelativePath: `.deletion-staging/${deletionId}/files/0`,
      }],
    })}\n`, { mode: 0o600 });

    await assert.rejects(
      ensureAxtoryDataDirectory(dataDirectory),
      /manifest contains an invalid path mapping/u,
    );
    assert.equal(await readFile(markerPath, "utf8"), markerBefore);
    assert.equal(await readFile(join(stagingRoot, "files", "0"), "utf8"), "malicious replacement\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("corrupt deletion staging cannot restore from another deletion journal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-deletion-staging-cross-journal-"));
  try {
    const dataDirectory = await ensureAxtoryDataDirectory(directory);
    const deletionId = "deletion_one";
    const stagingRoot = join(dataDirectory, ".deletion-staging", deletionId);
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(stagingRoot, "manifest.json"), `${JSON.stringify({
      schemaVersion: "axtory.deletion-staging.v1",
      deletionId,
      ownerPid: 2_147_483_647,
      createdAt: "2026-08-14T00:00:00.000Z",
      entries: [{
        originalRelativePath: "spool/spool_00000000000000000000000000000000.json",
        stagedRelativePath: ".deletion-staging/deletion_other/files/0",
      }],
    })}\n`, { mode: 0o600 });

    await assert.rejects(
      ensureAxtoryDataDirectory(dataDirectory),
      /manifest contains an invalid path mapping/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
