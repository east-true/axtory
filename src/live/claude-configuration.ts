import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { sha256 } from "../core/canonical-json.js";

interface JsonObject { [key: string]: unknown }

export interface ClaudeLiveConfigurationPlan {
  settingsPath: string;
  settingsExists: boolean;
  channels: readonly ("HOOKS" | "OTEL_METRICS_LOGS")[];
  hookEvents: readonly string[];
  environmentKeysSetOrReplaced: readonly string[];
  backupDirectory: string;
  requiredConfirmation: "APPLY_CLAUDE_LIVE_CONFIG";
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a JSON object`);
  return value as JsonObject;
}

/**
 * Recognize a hook group AXtory itself wrote. The receiver binds an ephemeral port unless one is
 * given, so a previous run's entry carries a different URL and would otherwise accumulate as a
 * permanent hook pointing at a dead port. Only AXtory's own entries match; user hooks are kept.
 */
function isAxtoryHookGroup(group: unknown): boolean {
  if (!group || typeof group !== "object" || Array.isArray(group)) return false;
  const hooks = (group as JsonObject).hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  return hooks.every((hook) => {
    if (!hook || typeof hook !== "object" || Array.isArray(hook)) return false;
    const item = hook as JsonObject;
    return Array.isArray(item.allowedEnvVars) && item.allowedEnvVars.includes("AXTORY_LIVE_TOKEN") &&
      typeof item.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/hooks\/[A-Za-z][A-Za-z0-9]*$/u.test(item.url);
  });
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export function mergeClaudeLiveSettings(input: {
  existing: unknown;
  endpoint: string;
  token: string;
  enableHooks: boolean;
  enableOtel: boolean;
}): JsonObject {
  if (!input.endpoint.startsWith("http://127.0.0.1:")) throw new Error("live endpoint must use IPv4 loopback");
  const existing = { ...object(input.existing, "Claude settings") };
  const env = existing.env === undefined ? {} : { ...object(existing.env, "Claude settings env") };
  if (input.enableHooks) {
    env.AXTORY_LIVE_TOKEN = input.token;
    const hooks = existing.hooks === undefined ? {} : { ...object(existing.hooks, "Claude settings hooks") };
    for (const event of ["PostToolUse", "Stop", "SessionEnd"]) {
      const current = hooks[event] === undefined ? [] : hooks[event];
      if (!Array.isArray(current)) throw new Error(`Claude hook ${event} must be an array`);
      const url = `${input.endpoint}/hooks/${event}`;
      hooks[event] = [...current.filter((group) => !isAxtoryHookGroup(group)), {
        matcher: "",
        hooks: [{
          type: "http", url, timeout: 5,
          headers: { Authorization: "Bearer $AXTORY_LIVE_TOKEN" },
          allowedEnvVars: ["AXTORY_LIVE_TOKEN"],
        }],
      }];
    }
    existing.hooks = hooks;
  }
  if (input.enableOtel) {
    Object.assign(env, {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_METRICS_EXPORTER: "otlp",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${input.endpoint}/v1/metrics`,
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${input.endpoint}/v1/logs`,
      OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${input.token}`,
      OTEL_LOG_USER_PROMPTS: "0",
      OTEL_LOG_TOOL_DETAILS: "0",
      OTEL_LOG_TOOL_CONTENT: "0",
      OTEL_LOG_RAW_API_BODIES: "0",
      OTEL_METRICS_INCLUDE_ACCOUNT_UUID: "false",
      OTEL_METRICS_INCLUDE_SESSION_ID: "false",
    });
  }
  if (input.enableHooks || input.enableOtel) existing.env = env;
  return existing;
}

export async function planClaudeLiveConfiguration(options: {
  settingsPath: string;
  enableHooks: boolean;
  enableOtel: boolean;
}): Promise<ClaudeLiveConfigurationPlan> {
  if (!options.enableHooks && !options.enableOtel) throw new Error("at least one live channel must be enabled");
  const settingsPath = resolve(options.settingsPath);
  let settingsExists = true;
  let existing: unknown = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") settingsExists = false;
    else throw new Error("Claude settings are not valid readable JSON", { cause: error });
  }
  // Validate merge compatibility without retaining or displaying a real receiver token.
  mergeClaudeLiveSettings({
    existing, endpoint: "http://127.0.0.1:4318", token: "plan-token-not-used-at-runtime-0000",
    enableHooks: options.enableHooks, enableOtel: options.enableOtel,
  });
  const environmentKeysSetOrReplaced = [
    ...(options.enableHooks ? ["AXTORY_LIVE_TOKEN"] : []),
    ...(options.enableOtel ? [
      "CLAUDE_CODE_ENABLE_TELEMETRY", "OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER",
      "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL", "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
      "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
      "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_LOG_USER_PROMPTS", "OTEL_LOG_TOOL_DETAILS",
      "OTEL_LOG_TOOL_CONTENT", "OTEL_LOG_RAW_API_BODIES", "OTEL_METRICS_INCLUDE_ACCOUNT_UUID",
      "OTEL_METRICS_INCLUDE_SESSION_ID",
    ] : []),
  ];
  return {
    settingsPath, settingsExists,
    channels: [
      ...(options.enableHooks ? ["HOOKS" as const] : []),
      ...(options.enableOtel ? ["OTEL_METRICS_LOGS" as const] : []),
    ],
    hookEvents: options.enableHooks ? ["PostToolUse", "Stop", "SessionEnd"] : [],
    environmentKeysSetOrReplaced,
    backupDirectory: join(dirname(settingsPath), ".axtory-backups"),
    requiredConfirmation: "APPLY_CLAUDE_LIVE_CONFIG",
  };
}

export async function applyClaudeLiveConfiguration(options: {
  settingsPath: string;
  endpoint: string;
  token: string;
  enableHooks: boolean;
  enableOtel: boolean;
  confirmation: string;
  now?: () => Date;
}): Promise<{ backupPath: string; settingsDigest: string }> {
  if (options.confirmation !== "APPLY_CLAUDE_LIVE_CONFIG") {
    throw new Error("live configuration requires --confirm APPLY_CLAUDE_LIVE_CONFIG");
  }
  if (!options.enableHooks && !options.enableOtel) throw new Error("at least one live channel must be enabled");
  const settingsPath = resolve(options.settingsPath);
  let existingBytes: Uint8Array | null = null;
  let existing: unknown = {};
  try {
    existingBytes = await readFile(settingsPath);
    existing = JSON.parse(new TextDecoder().decode(existingBytes));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Claude settings are not valid readable JSON", { cause: error });
  }
  const merged = mergeClaudeLiveSettings({ ...options, existing });
  const backupDirectory = join(dirname(settingsPath), ".axtory-backups");
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const timestamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/gu, "-");
  const backupPath = join(backupDirectory, `settings-${timestamp}-${randomUUID()}.json`);
  const backupEnvelope = {
    schemaVersion: "axtory.claude-settings-backup.v1",
    settingsPath,
    existed: existingBytes !== null,
    contentBase64: existingBytes ? Buffer.from(existingBytes).toString("base64") : "",
  };
  await writeAtomically(backupPath, new TextEncoder().encode(`${JSON.stringify(backupEnvelope)}\n`));
  const body = new TextEncoder().encode(`${JSON.stringify(merged, null, 2)}\n`);
  await writeAtomically(settingsPath, body);
  return { backupPath, settingsDigest: sha256(body) };
}

export async function rollbackClaudeLiveConfiguration(options: {
  settingsPath: string;
  backupPath: string;
  confirmation: string;
}): Promise<void> {
  if (options.confirmation !== "ROLLBACK_CLAUDE_LIVE_CONFIG") {
    throw new Error("configuration rollback requires --confirm ROLLBACK_CLAUDE_LIVE_CONFIG");
  }
  const settingsPath = resolve(options.settingsPath);
  const backupDirectory = resolve(dirname(settingsPath), ".axtory-backups");
  const backupPath = resolve(options.backupPath);
  if (relative(backupDirectory, backupPath).startsWith("..")) throw new Error("backup is outside the settings backup directory");
  const envelope = JSON.parse(await readFile(backupPath, "utf8")) as Record<string, unknown>;
  if (envelope.schemaVersion !== "axtory.claude-settings-backup.v1" || envelope.settingsPath !== settingsPath ||
      typeof envelope.existed !== "boolean" || typeof envelope.contentBase64 !== "string") {
    throw new Error("invalid Claude settings backup");
  }
  if (envelope.existed) {
    await writeAtomically(settingsPath, Buffer.from(envelope.contentBase64, "base64"));
  } else {
    await rm(settingsPath, { force: true });
  }
}
