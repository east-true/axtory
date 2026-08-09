import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverClaude,
  type CommandRunner,
  type CommandResult,
} from "../../../src/connectors/claude/discovery.js";

class FakeRunner implements CommandRunner {
  constructor(private readonly responses: Readonly<Record<string, CommandResult>>) {}

  async run(_command: string, args: readonly string[]): Promise<CommandResult> {
    const key = args.join(" ");
    return this.responses[key] ?? { exitCode: 1, stdout: "", stderr: "not found" };
  }
}

test("discovery honors custom config root and retains no account identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "axtory-discovery-"));
  const bin = join(root, "bin");
  const config = join(root, "claude-config");
  await mkdir(bin);
  await mkdir(config);
  const executable = join(bin, "claude");
  await writeFile(executable, "#!/bin/sh\n", { mode: 0o700 });
  const runner = new FakeRunner({
    "--version": { exitCode: 0, stdout: "2.1.226 (Claude Code)\n", stderr: "" },
    "auth status --json": {
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "private@example.com",
        orgId: "private-org",
      }),
      stderr: "",
    },
  });
  const discovery = await discoverClaude({
    env: { PATH: bin, CLAUDE_CONFIG_DIR: config, WSL_DISTRO_NAME: "Ubuntu" },
    platform: "linux",
    architecture: "x64",
    home: join(root, "home"),
    runner,
    now: () => new Date("2026-08-09T00:00:00.000Z"),
  });
  assert.equal(discovery.environment.type, "WSL");
  assert.deepEqual(discovery.sourceProfile.dataRoot, { status: "AVAILABLE", value: config });
  assert.deepEqual(discovery.sourceProfile.activeVersion, { status: "AVAILABLE", value: "2.1.226" });
  assert.equal(discovery.authMethod, "claude.ai");
  const encoded = JSON.stringify(discovery);
  assert.equal(encoded.includes("private@example.com"), false);
  assert.equal(encoded.includes("private-org"), false);
});

test("missing executable is an explicit source-unavailable capability", async () => {
  const root = await mkdtemp(join(tmpdir(), "axtory-missing-"));
  const discovery = await discoverClaude({
    env: { PATH: join(root, "empty") },
    platform: "linux",
    home: root,
    runner: new FakeRunner({}),
  });
  assert.equal(discovery.sourceProfile.executablePath.status, "SOURCE_UNAVAILABLE");
  assert.equal(discovery.sourceProfile.activeVersion.status, "SOURCE_UNAVAILABLE");
});
