import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runWalkingSkeleton } from "../../src/core/pipeline.js";

test("report-usage CLI emits a privacy-safe user-facing report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-usage-cli-"));
  try {
    await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "fixture.json"), randomId: () => "usage-cli-fixture",
    });
    const output = join(directory, "usage.json");
    const result = spawnSync(process.execPath, [
      join(process.cwd(), "dist/src/cli.js"), "report-usage",
      "--data-dir", directory, "--json-out", output, "--source", "fixture",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /AXtory AI usage report/u);
    assert.match(result.stdout, /Sessions: 1/u);
    assert.match(result.stdout, /file-change: 2/u);
    assert.match(result.stdout, /Semantics: NOT_COLLECTED/u);
    const saved = JSON.parse(await readFile(output, "utf8")) as { schemaVersion: string };
    assert.equal(saved.schemaVersion, "axtory.usage-report.v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
