import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  applyClaudeLiveConfiguration,
  mergeClaudeLiveSettings,
  planClaudeLiveConfiguration,
  rollbackClaudeLiveConfiguration,
} from "../../src/live/claude-configuration.js";

test("Claude live configuration preserves existing settings and adds idempotent privacy-safe hook and OTel config", () => {
  const token = "synthetic-token-that-is-at-least-32-characters";
  const existing = {
    theme: "dark",
    env: { EXISTING: "preserved", OTEL_LOG_USER_PROMPTS: "1" },
    hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "existing-command" }] }] },
  };
  const merged = mergeClaudeLiveSettings({
    existing, endpoint: "http://127.0.0.1:43210", token, enableHooks: true, enableOtel: true,
  });
  const twice = mergeClaudeLiveSettings({
    existing: merged, endpoint: "http://127.0.0.1:43210", token, enableHooks: true, enableOtel: true,
  });
  assert.deepEqual(twice, merged);
  assert.equal(merged.theme, "dark");
  const env = merged.env as Record<string, string>;
  assert.equal(env.EXISTING, "preserved");
  assert.equal(env.OTEL_LOG_USER_PROMPTS, "0");
  assert.equal(env.OTEL_LOG_TOOL_DETAILS, "0");
  assert.equal(env.OTEL_LOG_RAW_API_BODIES, "0");
  assert.equal(env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL, "http/json");
  const hooks = merged.hooks as Record<string, unknown[]>;
  assert.equal(hooks.Stop?.length, 2);
  assert.equal(JSON.stringify(merged).includes("existing-command"), true);
});

test("Claude live configuration is backed up atomically and can be restored exactly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-live-config-"));
  const settingsPath = join(directory, "settings.json");
  const original = "{\n  \"theme\": \"dark\"\n}\n";
  try {
    await writeFile(settingsPath, original, { mode: 0o600 });
    const plan = await planClaudeLiveConfiguration({ settingsPath, enableHooks: true, enableOtel: true });
    assert.equal(plan.settingsExists, true);
    assert.deepEqual(plan.channels, ["HOOKS", "OTEL_METRICS_LOGS"]);
    assert.equal(plan.requiredConfirmation, "APPLY_CLAUDE_LIVE_CONFIG");
    assert.equal(await readFile(settingsPath, "utf8"), original);
    await assert.rejects(() => applyClaudeLiveConfiguration({
      settingsPath, endpoint: "http://127.0.0.1:4318", token: "x".repeat(32),
      enableHooks: true, enableOtel: false, confirmation: "wrong",
    }), /requires --confirm/u);
    const result = await applyClaudeLiveConfiguration({
      settingsPath, endpoint: "http://127.0.0.1:4318", token: "x".repeat(32),
      enableHooks: true, enableOtel: true, confirmation: "APPLY_CLAUDE_LIVE_CONFIG",
      now: () => new Date("2026-08-09T00:00:00.000Z"),
    });
    assert.notEqual(await readFile(settingsPath, "utf8"), original);
    assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
    await assert.rejects(() => rollbackClaudeLiveConfiguration({
      settingsPath, backupPath: result.backupPath, confirmation: "wrong",
    }), /requires --confirm/u);
    await rollbackClaudeLiveConfiguration({
      settingsPath, backupPath: result.backupPath, confirmation: "ROLLBACK_CLAUDE_LIVE_CONFIG",
    });
    assert.equal(await readFile(settingsPath, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
