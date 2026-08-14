import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { writeJsonAtomically } from "../../src/core/output.js";

test("atomic JSON output removes its temporary file when the final rename fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-output-atomicity-"));
  try {
    const target = join(directory, "output.json");
    await mkdir(target);

    await assert.rejects(writeJsonAtomically(target, { value: 1 }));

    const prefix = `${basename(target)}.`;
    const leftovers = (await readdir(directory)).filter((entry) =>
      entry.startsWith(prefix) && entry.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
