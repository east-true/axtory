import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { discoverCodex } from "../../../src/connectors/codex/discovery.js";
import type { CommandRunner } from "../../../src/connectors/claude/discovery.js";

test("Codex discovery honors CODEX_HOME and retains no login identifier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-discovery-"));
  const binaryDirectory = join(directory, "bin");
  const codexHome = join(directory, "state");
  try {
    await Promise.all([mkdir(binaryDirectory), mkdir(codexHome)]);
    const executable = join(binaryDirectory, "codex");
    await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await chmod(executable, 0o700);
    const database = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    database.exec("CREATE TABLE sample(value TEXT)");
    database.close();
    const privateIdentifier = "private@example.test";
    const runner: CommandRunner = {
      async run(_command, args) {
        return args[0] === "--version"
          ? { exitCode: 0, stdout: "codex-cli 0.147.0\n", stderr: "" }
          : { exitCode: 0, stdout: `Logged in using ChatGPT ${privateIdentifier}\n`, stderr: "" };
      },
    };
    const result = await discoverCodex({
      env: { PATH: binaryDirectory, CODEX_HOME: codexHome }, home: directory,
      platform: "linux", architecture: "x64", runner,
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    assert.deepEqual(result.sourceProfile.dataRoot, { status: "AVAILABLE", value: codexHome });
    assert.deepEqual(result.sourceProfile.activeVersion, { status: "AVAILABLE", value: "0.147.0" });
    assert.equal(result.capabilityAssessment.capabilities.find((item) => item.key === "codex.login")?.availability,
      "AVAILABLE");
    assert.equal(JSON.stringify(result).includes(privateIdentifier), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
