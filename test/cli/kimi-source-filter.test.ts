import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/src/cli.js");

test("report-usage accepts kimi as the advertised Kimi Code source filter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-kimi-source-filter-"));
  try {
    const output = join(directory, "usage.json");
    await execFileAsync(process.execPath, [
      cli,
      "report-usage",
      "--data-dir", join(directory, "data"),
      "--json-out", output,
      "--source", "kimi",
    ], { cwd: directory, encoding: "utf8" });

    const report = JSON.parse(await readFile(output, "utf8")) as {
      scope: { sourceTypes: string[] };
    };
    assert.deepEqual(report.scope.sourceTypes, ["ADDITIONAL_AI_KIMI_CODE"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
