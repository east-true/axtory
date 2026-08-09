import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createCodexHomeSnapshot, findCodexStateDatabase } from "../../../src/connectors/codex/snapshot.js";

test("Codex state snapshot selects the newest schema and does not modify the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "axtory-codex-source-"));
  try {
    for (const name of ["state_3.sqlite", "state_5.sqlite"]) {
      const database = new DatabaseSync(join(root, name));
      database.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('before');");
      database.close();
    }
    assert.equal(await findCodexStateDatabase(root), join(root, "state_5.sqlite"));
    const before = (await stat(join(root, "state_5.sqlite"))).mtimeMs;
    const snapshot = await createCodexHomeSnapshot(root);
    try {
      const copied = new DatabaseSync(join(snapshot.path, "state_5.sqlite"), { readOnly: true });
      assert.equal((copied.prepare("SELECT value FROM sample").get() as { value: string }).value, "before");
      copied.close();
      assert.equal((await stat(join(root, "state_5.sqlite"))).mtimeMs, before);
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
