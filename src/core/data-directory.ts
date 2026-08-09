import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, parse, resolve } from "node:path";

const MARKER = ".axtory-data-directory";
const MARKER_CONTENT = "axtory.data-directory.v1\n";

export async function ensureAxtoryDataDirectory(path: string): Promise<string> {
  const target = resolve(path);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await chmod(target, 0o700);
  const marker = resolve(target, MARKER);
  try {
    const existing = await readFile(marker, "utf8");
    if (existing !== MARKER_CONTENT) throw new Error("data directory marker is invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const knownLegacyEntries = new Set([
      "axtory.sqlite3",
      "axtory.sqlite3-shm",
      "axtory.sqlite3-wal",
      "blobs",
      "output.json",
    ]);
    const unexpected = (await readdir(target)).filter((entry) => !knownLegacyEntries.has(entry));
    if (unexpected.length > 0) {
      throw new Error("refusing to mark a non-empty directory that contains non-AXtory files");
    }
    await writeFile(marker, MARKER_CONTENT, { flag: "wx", mode: 0o600 });
  }
  return target;
}

export async function purgeAxtoryDataDirectory(path: string, confirmation: string): Promise<void> {
  if (confirmation !== "PURGE_ALL") throw new Error("purge requires --confirm PURGE_ALL");
  const target = resolve(path);
  const forbidden = new Set([parse(target).root, resolve(homedir()), resolve(process.cwd())]);
  if (forbidden.has(target) || target === dirname(target)) {
    throw new Error("refusing to purge a broad or protected directory");
  }
  const marker = await readFile(resolve(target, MARKER), "utf8");
  if (marker !== MARKER_CONTENT) throw new Error("refusing to purge a directory without a valid AXtory marker");
  await rm(target, { recursive: true, force: false });
}
