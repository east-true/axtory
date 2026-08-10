import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = resolve("dist/src/cli.js");

async function run(args: readonly string[], cwd: string): Promise<{ code: number; stderr: string; stdout: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const candidate = error as { code?: number; stdout?: string; stderr?: string };
    return { code: candidate.code ?? 1, stdout: candidate.stdout ?? "", stderr: candidate.stderr ?? "" };
  }
}

test("a flag given without a value fails instead of silently dropping the request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-cli-parse-"));
  try {
    // `--since` last on the line used to be ignored, so a user who asked for a bounded report
    // silently received an unbounded one.
    const trailing = await run(
      ["report-usage", "--data-dir", join(directory, "data"), "--json-out", join(directory, "u.json"), "--since"],
      directory,
    );
    assert.equal(trailing.code, 1);
    assert.match(trailing.stderr, /--since requires a value/u);

    // `--data-dir --json-out out.json` used to consume the next flag as the value, creating a data
    // directory literally named `--json-out` and reporting on it.
    const swallowed = await run(
      ["report-usage", "--data-dir", "--json-out", join(directory, "u.json")],
      directory,
    );
    assert.equal(swallowed.code, 1);
    assert.match(swallowed.stderr, /--data-dir requires a value/u);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a repeatable flag given without a value also fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-cli-repeat-"));
  try {
    const result = await run(
      ["report-usage", "--data-dir", join(directory, "data"), "--json-out", join(directory, "u.json"), "--source"],
      directory,
    );
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--source requires a value/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a value beginning with a single dash is still accepted as free text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-cli-freetext-"));
  try {
    const dataDirectory = join(directory, "data");
    await run([
      "collect-fixture", "--fixture", resolve("fixtures/synthetic/normal-session.json"),
      "--data-dir", dataDirectory, "--json-out", join(directory, "out.json"),
    ], directory);
    const listed = await run(["list", "--data-dir", dataDirectory], directory);
    const revisionId = (JSON.parse(listed.stdout) as {
      sources: Array<{ revisions: Array<{ revisionId: string }> }>;
    }).sources[0]?.revisions[0]?.revisionId;
    assert.ok(revisionId);

    const annotated = await run([
      "annotate", "--data-dir", dataDirectory, "--target-type", "SOURCE_REVISION",
      "--target-id", revisionId, "--assertion", "-15 minutes of rework",
    ], directory);
    assert.equal(annotated.code, 0, annotated.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
