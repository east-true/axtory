import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const STATE_DATABASE_PATTERN = /^state_(\d+)\.sqlite$/u;

export interface CodexHomeSnapshot {
  path: string;
  sourceDatabaseName: string;
  dispose(): Promise<void>;
}

export async function findCodexStateDatabase(codexHome: string): Promise<string> {
  const candidates = (await readdir(codexHome, { withFileTypes: true }))
    .flatMap((entry) => {
      if (!entry.isFile()) return [];
      const match = entry.name.match(STATE_DATABASE_PATTERN);
      return match ? [{ name: entry.name, version: Number(match[1]) }] : [];
    })
    .filter((entry) => Number.isSafeInteger(entry.version))
    .sort((left, right) => right.version - left.version);
  const selected = candidates[0];
  if (!selected) throw new Error("Codex state database was not found in the configured data root");
  return join(codexHome, selected.name);
}

export async function createCodexHomeSnapshot(codexHome: string): Promise<CodexHomeSnapshot> {
  const sourceDatabase = await findCodexStateDatabase(codexHome);
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-home-"));
  await chmod(directory, 0o700);
  const database = new DatabaseSync(sourceDatabase, { readOnly: true });
  try {
    await backup(database, join(directory, basename(sourceDatabase)));
    await chmod(join(directory, basename(sourceDatabase)), 0o600);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("could not create a consistent read-only snapshot of Codex state", { cause: error });
  } finally {
    database.close();
  }
  let disposed = false;
  return {
    path: directory,
    sourceDatabaseName: basename(sourceDatabase),
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(directory, { recursive: true, force: true });
    },
  };
}
