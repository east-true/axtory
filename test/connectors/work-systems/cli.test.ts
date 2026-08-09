import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("work-system CLI rejects literal credentials without echoing them", () => {
  const secret = "CLI-SECRET-MUST-NOT-ECHO";
  const result = spawnSync(process.execPath, [
    join(process.cwd(), "dist/src/cli.js"), "collect-work-system",
    "--provider", "github", "--repository", "example/repo",
    "--data-dir", "/tmp/axtory-cli-test", "--json-out", "/tmp/axtory-cli-test.json",
    `--token=${secret}`,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credentials must be supplied through environment variables/u);
  assert.equal(result.stderr.includes(secret), false);
  assert.equal(result.stdout.includes(secret), false);
});
