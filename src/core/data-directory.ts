import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { reconcileDeletionStaging } from "./deletion-staging.js";
import { reconcileIncompleteRevisions } from "./incomplete-revision-recovery.js";
import { withDataMutationLock } from "./mutation-lock.js";

const MARKER = ".axtory-data-directory";
const MARKER_CONTENT = "axtory.data-directory.v1\n";
const MUTATION_LOCK = ".axtory-mutation-lock";

function containsPath(directory: string, candidate: string): boolean {
  const nested = relative(directory, candidate);
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested));
}

async function verifyMarker(marker: string): Promise<void> {
  const metadata = await lstat(marker);
  if (!metadata.isFile()) throw new Error("data directory marker is invalid");
  const existing = await readFile(marker, "utf8");
  if (existing !== MARKER_CONTENT) throw new Error("data directory marker is invalid");
}

export async function ensureAxtoryDataDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const target = await realpath(requested);
  await chmod(target, 0o700);
  const marker = resolve(target, MARKER);
  try {
    await verifyMarker(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const knownLegacyEntries = new Set([
      MARKER,
      "axtory.sqlite3",
      "axtory.sqlite3-shm",
      "axtory.sqlite3-wal",
      "blobs",
      "output.json",
      ".deletion-staging",
      MUTATION_LOCK,
    ]);
    const unexpected = (await readdir(target)).filter((entry) => !knownLegacyEntries.has(entry));
    if (unexpected.length > 0) {
      throw new Error("refusing to mark a non-empty directory that contains non-AXtory files");
    }
    try {
      await writeFile(marker, MARKER_CONTENT, { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== "EEXIST") throw writeError;
      await verifyMarker(marker);
    }
  }
  await withDataMutationLock(target, async () => {
    await reconcileDeletionStaging(target);
    await reconcileIncompleteRevisions(target);
  });
  return target;
}

export async function purgeAxtoryDataDirectory(path: string, confirmation: string): Promise<void> {
  if (confirmation !== "PURGE_ALL") throw new Error("purge requires --confirm PURGE_ALL");
  const target = await realpath(resolve(path));
  const [home, workingDirectory] = await Promise.all([
    realpath(resolve(homedir())),
    realpath(resolve(process.cwd())),
  ]);
  const protectedPaths = [parse(target).root, home, workingDirectory];
  if (protectedPaths.some((protectedPath) => containsPath(target, protectedPath))) {
    throw new Error("refusing to purge a broad or protected directory");
  }
  try {
    await verifyMarker(resolve(target, MARKER));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error("refusing to purge a directory without a valid AXtory marker", { cause: error });
  }
  await withDataMutationLock(target, async () => {
    await verifyMarker(resolve(target, MARKER));
    // The mutation lease lives inside the data directory. Removing the directory recursively here
    // would publish an unlocked path before the protected purge operation had actually returned.
    // Delete every AXtory payload while the lease remains present; the lease itself is released by
    // withDataMutationLock after this callback finishes.
    for (const entry of await readdir(target)) {
      if (entry === MUTATION_LOCK) continue;
      await rm(resolve(target, entry), { recursive: true, force: false });
    }
  });
  try {
    await rmdir(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A new AXtory operation may legitimately recreate the directory after the purge lease releases.
    // Its data is newer than the completed purge and must never be recursively removed by this call.
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") return;
    throw error;
  }
}
