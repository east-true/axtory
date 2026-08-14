import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { withDataMutationLock } from "../../src/core/mutation-lock.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
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

test("an HTTP callback created under a live lease can re-enter that lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-mutation-http-reentrant-"));
  let server: Server | null = null;
  try {
    await withDataMutationLock(directory, async () => {
      server = createServer((_request, response) => {
        void withDataMutationLock(directory, () => {
          response.writeHead(204);
          response.end();
        }, 100).catch((error: unknown) => {
          response.writeHead(500);
          response.end(error instanceof Error ? error.message : "unknown");
        });
      });
      await new Promise<void>((resolvePromise, reject) => {
        server!.once("error", reject);
        server!.listen(0, "127.0.0.1", () => {
          server!.off("error", reject);
          resolvePromise();
        });
      });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      assert.equal(response.status, 204);
      await closeServer(server);
      server = null;
    }, 100);
  } finally {
    if (server) await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("an async descendant cannot reuse an inherited lease after its owner operation returned", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-mutation-detached-"));
  const wakeDetached = deferred();
  const blockerEntered = deferred();
  const releaseBlocker = deferred();
  let detached: Promise<void> | undefined;
  let detachedInside = false;
  try {
    await withDataMutationLock(directory, async () => {
      // This callback inherits the AsyncLocalStorage context, but deliberately outlives the operation.
      detached = new Promise<void>((resolveDetached, rejectDetached) => {
        setTimeout(() => {
          void (async () => {
            await wakeDetached.promise;
            await withDataMutationLock(directory, async () => { detachedInside = true; }, 2_000);
          })().then(resolveDetached, rejectDetached);
        }, 0);
      });
    });

    const blocker = withDataMutationLock(directory, async () => {
      blockerEntered.resolve();
      await releaseBlocker.promise;
    }, 2_000);
    await blockerEntered.promise;
    wakeDetached.resolve();

    await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
    assert.equal(detachedInside, false, "a released inherited lease must not bypass the current holder");
    releaseBlocker.resolve();
    await blocker;
    await detached;
    assert.equal(detachedInside, true);
  } finally {
    wakeDetached.resolve();
    releaseBlocker.resolve();
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
