import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const LOCK_DIRECTORY = ".axtory-mutation-lock";
const OWNER_FILE = "owner.json";
const OWNER_GRACE_MS = 1_000;
const DEFAULT_WAIT_MS = 30_000;
const RETRY_MS = 25;

interface LockOwner {
  schemaVersion: "axtory.mutation-lock.v1";
  pid: number;
  token: string;
  createdAt: string;
}

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function owner(lockDirectory: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(join(lockDirectory, OWNER_FILE), "utf8")) as Partial<LockOwner>;
    return value.schemaVersion === "axtory.mutation-lock.v1" &&
      typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 &&
      typeof value.token === "string" && value.token.length > 0 &&
      typeof value.createdAt === "string"
      ? value as LockOwner
      : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function recoverStaleLock(lockDirectory: string): Promise<boolean> {
  const currentOwner = await owner(lockDirectory);
  if (currentOwner && processAlive(currentOwner.pid)) return false;
  if (!currentOwner) {
    try {
      const metadata = await stat(lockDirectory);
      if (Date.now() - metadata.mtimeMs < OWNER_GRACE_MS) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw error;
    }
  }
  const stale = `${lockDirectory}.stale.${process.pid}.${randomUUID()}`;
  try {
    await rename(lockDirectory, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
  await rm(stale, { recursive: true, force: true });
  return true;
}

async function acquire(dataDirectory: string, waitMs: number): Promise<{ lockDirectory: string; token: string }> {
  const root = resolve(dataDirectory);
  const lockDirectory = join(root, LOCK_DIRECTORY);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const token = randomUUID();
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      const value: LockOwner = {
        schemaVersion: "axtory.mutation-lock.v1",
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      };
      try {
        await writeFile(join(lockDirectory, OWNER_FILE), `${JSON.stringify(value)}\n`, {
          flag: "wx", mode: 0o600,
        });
      } catch (error) {
        await rm(lockDirectory, { recursive: true, force: true });
        throw error;
      }
      return { lockDirectory, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await recoverStaleLock(lockDirectory)) continue;
      if (Date.now() >= deadline) throw new Error("AXtory data directory is busy with another mutation");
      await sleep(RETRY_MS);
    }
  }
}

async function release(lockDirectory: string, token: string): Promise<void> {
  const currentOwner = await owner(lockDirectory);
  if (!currentOwner) return;
  if (currentOwner.pid !== process.pid || currentOwner.token !== token) {
    throw new Error("AXtory mutation lock ownership changed before release");
  }
  await rm(lockDirectory, { recursive: true, force: false });
}

/**
 * Serialize filesystem + SQLite mutations for one AXtory data directory across processes.
 *
 * The lease is re-entrant only inside the async call tree that acquired it. Independent callbacks
 * in the same process still contend, which is required for live receiver capacity accounting.
 */
export async function withDataMutationLock<T>(
  dataDirectory: string,
  operation: () => Promise<T> | T,
  waitMs = DEFAULT_WAIT_MS,
): Promise<T> {
  const root = resolve(dataDirectory);
  const inherited = heldLocks.getStore();
  if (inherited?.has(root)) return await operation();

  const { lockDirectory, token } = await acquire(root, waitMs);
  const locks = new Set(inherited ?? []);
  locks.add(root);
  try {
    return await heldLocks.run(locks, async () => await operation());
  } finally {
    await release(lockDirectory, token);
  }
}
