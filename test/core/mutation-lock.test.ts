import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { withDataMutationLock } from "../../src/core/mutation-lock.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("a mutation lease is re-entrant only inside the acquiring async call tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-mutation-reentrant-"));
  try {
    let nested = false;
    await withDataMutationLock(directory, async () => {
      await withDataMutationLock(directory, async () => { nested = true; }, 50);
    }, 50);
    assert.equal(nested, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent mutation callers for one data directory are serialized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-mutation-serialized-"));
  const entered = deferred();
  const release = deferred();
  const secondEntered = deferred();
  try {
    const first = withDataMutationLock(directory, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;

    let secondInside = false;
    const second = withDataMutationLock(directory, async () => {
      secondInside = true;
      secondEntered.resolve();
    }, 2_000);

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    assert.equal(secondInside, false, "an independent caller must not enter while the first holds the lease");
    release.resolve();
    await first;
    await secondEntered.promise;
    await second;
    assert.equal(secondInside, true);
  } finally {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a mutation lease recovers a lock whose owner process no longer exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-mutation-stale-"));
  const lockDirectory = join(directory, ".axtory-mutation-lock");
  try {
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
      schemaVersion: "axtory.mutation-lock.v1",
      pid: 2_147_483_647,
      token: "stale-owner",
      createdAt: "2000-01-01T00:00:00.000Z",
    })}\n`, { mode: 0o600 });

    let entered = false;
    await withDataMutationLock(directory, async () => { entered = true; }, 1_000);
    assert.equal(entered, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
