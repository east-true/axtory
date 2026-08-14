import { open, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STAGING_DIRECTORY = ".deletion-staging";
const MANIFEST_NAME = "manifest.json";

interface StagedDeletionEntry {
  originalRelativePath: string;
  stagedRelativePath: string;
}

interface StagedDeletionManifest {
  schemaVersion: "axtory.deletion-staging.v1";
  deletionId: string;
  ownerPid: number;
  createdAt: string;
  entries: readonly StagedDeletionEntry[];
}

function safeRelative(root: string, absolutePath: string): string {
  const target = resolve(absolutePath);
  const nested = relative(root, target);
  if (nested === "" || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error("deletion staging path is outside the AXtory data directory");
  }
  return nested;
}

function safeResolve(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error("deletion staging manifest contains an unsafe path");
  }
  const target = resolve(root, relativePath);
  const nested = relative(root, target);
  if (nested === "" || nested === ".." || nested.startsWith(`..${sep}`) || isAbsolute(nested)) {
    throw new Error("deletion staging manifest contains an unsafe path");
  }
  return target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeManifest(path: string, manifest: StagedDeletionManifest): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function parseManifest(value: unknown): StagedDeletionManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deletion staging manifest is invalid");
  }
  const item = value as Partial<StagedDeletionManifest>;
  if (item.schemaVersion !== "axtory.deletion-staging.v1" ||
    typeof item.deletionId !== "string" || !/^deletion_[A-Za-z0-9._:-]{1,200}$/u.test(item.deletionId) ||
    typeof item.ownerPid !== "number" || !Number.isInteger(item.ownerPid) || item.ownerPid < 1 ||
    typeof item.createdAt !== "string" || !Array.isArray(item.entries)) {
    throw new Error("deletion staging manifest is invalid");
  }
  for (const entry of item.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof (entry as StagedDeletionEntry).originalRelativePath !== "string" ||
      typeof (entry as StagedDeletionEntry).stagedRelativePath !== "string") {
      throw new Error("deletion staging manifest is invalid");
    }
  }
  return item as StagedDeletionManifest;
}

async function loadManifest(dataDirectory: string, deletionId: string): Promise<StagedDeletionManifest> {
  const stagingRoot = join(dataDirectory, STAGING_DIRECTORY, deletionId);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(stagingRoot, MANIFEST_NAME), "utf8"));
  } catch (error) {
    throw new Error("deletion staging manifest is not readable JSON", { cause: error });
  }
  const manifest = parseManifest(parsed);
  if (manifest.deletionId !== deletionId) throw new Error("deletion staging manifest identity mismatch");
  return manifest;
}

async function rollbackManifest(dataDirectory: string, manifest: StagedDeletionManifest): Promise<void> {
  for (const entry of [...manifest.entries].reverse()) {
    const original = safeResolve(dataDirectory, entry.originalRelativePath);
    const staged = safeResolve(dataDirectory, entry.stagedRelativePath);
    if (!await exists(staged)) continue;
    if (await exists(original)) throw new Error("cannot restore staged deletion because the original path already exists");
    await mkdir(dirname(original), { recursive: true, mode: 0o700 });
    await rename(staged, original);
  }
  await rm(join(dataDirectory, STAGING_DIRECTORY, manifest.deletionId), { recursive: true, force: true });
}

export async function stageDeletionFiles(options: {
  dataDirectory: string;
  deletionId: string;
  paths: readonly string[];
  createdAt: string;
}): Promise<number> {
  const dataDirectory = resolve(options.dataDirectory);
  const stagingParent = join(dataDirectory, STAGING_DIRECTORY);
  const stagingRoot = join(stagingParent, options.deletionId);
  await mkdir(stagingParent, { recursive: true, mode: 0o700 });
  await mkdir(stagingRoot, { mode: 0o700 });

  const originals = [...new Set(options.paths.map((path) => resolve(path)))].sort();
  const entries = originals.map((path, index): StagedDeletionEntry => ({
    originalRelativePath: safeRelative(dataDirectory, path),
    stagedRelativePath: relative(dataDirectory, join(stagingRoot, "files", String(index))),
  }));
  const manifest: StagedDeletionManifest = {
    schemaVersion: "axtory.deletion-staging.v1",
    deletionId: options.deletionId,
    ownerPid: process.pid,
    createdAt: options.createdAt,
    entries,
  };
  await writeManifest(join(stagingRoot, MANIFEST_NAME), manifest);

  try {
    for (const entry of entries) {
      const original = safeResolve(dataDirectory, entry.originalRelativePath);
      const staged = safeResolve(dataDirectory, entry.stagedRelativePath);
      await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
      await rename(original, staged);
    }
    return entries.length;
  } catch (error) {
    await rollbackManifest(dataDirectory, manifest);
    throw error;
  }
}

export async function rollbackStagedDeletion(dataDirectory: string, deletionId: string): Promise<void> {
  await rollbackManifest(resolve(dataDirectory), await loadManifest(resolve(dataDirectory), deletionId));
}

export async function completeStagedDeletion(dataDirectory: string, deletionId: string): Promise<void> {
  await rm(join(resolve(dataDirectory), STAGING_DIRECTORY, deletionId), { recursive: true, force: true });
  try {
    await rm(join(resolve(dataDirectory), STAGING_DIRECTORY), { recursive: false, force: false });
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function reconcileDeletionStaging(dataDirectory: string): Promise<number> {
  const root = resolve(dataDirectory);
  const stagingParent = join(root, STAGING_DIRECTORY);
  let deletionIds: string[];
  try {
    deletionIds = (await readdir(stagingParent, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  if (deletionIds.length === 0) return 0;

  const manifests = await Promise.all(deletionIds.map((id) => loadManifest(root, id)));
  const databasePath = join(root, "axtory.sqlite3");
  let database: DatabaseSync | null = null;
  let hasDeletionTable = false;
  try {
    if (await exists(databasePath)) {
      database = new DatabaseSync(databasePath);
      hasDeletionTable = Boolean(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'deletion_runs'",
      ).get());
    }
    const committed: StagedDeletionManifest[] = [];
    const uncommitted: StagedDeletionManifest[] = [];
    for (const manifest of manifests) {
      const row = hasDeletionTable && database
        ? database.prepare("SELECT id FROM deletion_runs WHERE id = ? AND status = 'COMPLETED'").get(manifest.deletionId)
        : undefined;
      (row ? committed : uncommitted).push(manifest);
    }

    // Only an uncommitted manifest can represent an operation that is still between staging and its
    // DB commit. A committed row is authoritative even if the process that created it is still alive
    // after a finalization error, so a retry in that same process may safely finish cleanup.
    for (const manifest of uncommitted) {
      if (processAlive(manifest.ownerPid)) {
        throw new Error("an AXtory deletion is still in progress for this data directory");
      }
    }
    for (const manifest of uncommitted) await rollbackManifest(root, manifest);
    if (committed.length > 0) {
      if (!database) throw new Error("committed deletion staging exists without its AXtory database");
      database.exec("PRAGMA secure_delete = ON; PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
      for (const manifest of committed) await completeStagedDeletion(root, manifest.deletionId);
    }
    return manifests.length;
  } finally {
    database?.close();
  }
}
