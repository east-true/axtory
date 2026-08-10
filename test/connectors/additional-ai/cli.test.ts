import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("additional AI CLI collects an explicit Aider history without an Aider installation", async () => {
  const secret = "PRIVATE-AIDER-CLI-CONTENT";
  const directory = await mkdtemp(join(tmpdir(), "axtory-additional-cli-"));
  try {
    const history = join(directory, "history.md");
    const data = join(directory, "data");
    const output = join(directory, "output.json");
    await writeFile(history, secret, "utf8");
    const result = spawnSync(process.execPath, [
      join(process.cwd(), "dist/src/cli.js"), "collect-additional-ai",
      "--provider", "aider", "--project-dir", directory, "--history-file", history,
      "--data-dir", data, "--json-out", output,
    ], { encoding: "utf8", env: { ...process.env, PATH: "" } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AIDER evidence/u);
    assert.equal(result.stdout.includes(secret), false);
    const outputText = await readFile(output, "utf8");
    assert.equal(outputText.includes(secret), false);
    const collection = JSON.parse(outputText) as {
      sessions: { metadataOnlyViews: number; unstructuredViews: number };
    };
    assert.equal(collection.sessions.metadataOnlyViews, 0);
    assert.equal(collection.sessions.unstructuredViews, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
