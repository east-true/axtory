import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256 } from "../../core/canonical-json.js";
import { isoTimestamp } from "../../core/time.js";
import {
  externalIdentifier, object,
  type AdditionalAiMessage, type AdditionalAiSessionSummary, type AdditionalAiSourceApi,
} from "./types.js";

const SESSION_INDEX_LIMIT_BYTES = 16 * 1024 * 1024;
const WIRE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Kimi Code persists sessions in a documented layout rather than behind a read command, so this
 * adapter reads those files directly instead of driving `kimi export`. The export path would answer
 * the same question but only as a ZIP, and it bundles a global diagnostic log that reaches outside
 * the session being described.
 *
 * Documented layout (`$KIMI_CODE_HOME`, default `~/.kimi-code`):
 *   session_index.jsonl            one record per line: sessionId, sessionDir, workDir
 *   sessions/<workDirKey>/<id>/state.json      title and creation/update timestamps
 *   sessions/<workDirKey>/<id>/agents/main/wire.jsonl   the agent event stream
 *
 * `wire.jsonl` lines are JSON-RPC 2.0. Only documented member names are read; nothing is inferred
 * from an unrecognized line, and a file whose lines never match a documented shape is reported as
 * an unreadable view rather than as a session with no messages.
 */
export class KimiCodeSourceApi implements AdditionalAiSourceApi {
  readonly provider = "KIMI_CODE" as const;
  readonly scopeIdentity: string;
  private readonly home: string;
  private readonly projectDirectory: string;

  constructor(options: { projectDirectory: string; home?: string }) {
    this.projectDirectory = resolve(options.projectDirectory);
    this.home = resolve(options.home ?? join(homedir(), ".kimi-code"));
    this.scopeIdentity = sha256(`kimi-code:${this.projectDirectory}`);
  }

  async listSessions(options: { limit: number }) {
    const indexPath = join(this.home, "session_index.jsonl");
    let body: string;
    try {
      const info = await stat(indexPath);
      if (info.size > SESSION_INDEX_LIMIT_BYTES) throw new Error("Kimi Code session index exceeds the 16 MiB limit");
      body = await readFile(indexPath, "utf8");
    } catch (error) {
      // The index is created with the first session, so its absence is an empty history and not a
      // collection failure.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { items: [], coverage: "COMPLETE_FOR_RETURNED_VIEW" as const };
      }
      throw error;
    }
    const lines = body.split("\n").filter((line) => line.trim().length > 0);
    let unreadableLines = 0;
    const scoped: AdditionalAiSessionSummary[] = [];
    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = object(JSON.parse(line), "Kimi Code session index record");
      } catch {
        unreadableLines += 1;
        continue;
      }
      if (typeof record.workDir !== "string" || typeof record.sessionDir !== "string") {
        unreadableLines += 1;
        continue;
      }
      if (resolve(record.workDir) !== this.projectDirectory) continue;
      scoped.push({
        provider: this.provider, scopeIdentity: this.scopeIdentity,
        externalId: externalIdentifier(record.sessionId, "Kimi Code session id"),
        createdAt: null, sourceUpdatedAt: null,
      });
    }
    // A record the documented shape does not cover means the enumeration is a subset of what the
    // index holds, so the returned view must not read as complete.
    return {
      items: scoped.slice(0, options.limit),
      coverage: scoped.length > options.limit || unreadableLines > 0
        ? "PARTIAL_LIMIT" as const
        : "COMPLETE_FOR_RETURNED_VIEW" as const,
    };
  }

  private async sessionDirectory(externalId: string): Promise<string> {
    const body = await readFile(join(this.home, "session_index.jsonl"), "utf8");
    for (const line of body.split("\n")) {
      if (line.trim().length === 0) continue;
      let record: Record<string, unknown>;
      try {
        record = object(JSON.parse(line), "Kimi Code session index record");
      } catch {
        continue;
      }
      if (record.sessionId !== externalId || typeof record.sessionDir !== "string") continue;
      const directory = isAbsolute(record.sessionDir)
        ? resolve(record.sessionDir)
        : resolve(this.home, record.sessionDir);
      // The index is Vendor data; refuse a record that points outside the Kimi Code home.
      if (directory !== this.home && !directory.startsWith(`${this.home}/`)) {
        throw new Error("Kimi Code session directory escapes the configured home");
      }
      return directory;
    }
    throw new Error("Kimi Code session is no longer present in the session index");
  }

  async readSession(summary: AdditionalAiSessionSummary) {
    if (summary.provider !== this.provider || summary.scopeIdentity !== this.scopeIdentity) {
      throw new Error("Kimi Code session summary is outside the configured scope");
    }
    const directory = await this.sessionDirectory(summary.externalId);
    const state = await readStateJson(join(directory, "state.json"));
    const wire = await readWireEvents(join(directory, "agents", "main", "wire.jsonl"));
    return {
      summary: {
        ...summary,
        createdAt: state.createdAt,
        sourceUpdatedAt: state.updatedAt,
      },
      coverage: wire.coverage,
      messages: wire.messages,
      // The raw view keeps the session state and the event stream, both of which carry conversation
      // content; canonical observations take only what the normalizer allowlists.
      rawPayload: { schemaVersion: "axtory.kimi-code.session.v1", state: state.raw, wire: wire.raw },
      provenance: "DOCUMENTED_STORAGE" as const,
      dataClassification: "CONVERSATION_CONTENT" as const,
    };
  }
}

async function readStateJson(path: string): Promise<{
  createdAt: string | null; updatedAt: string | null; raw: unknown;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { createdAt: null, updatedAt: null, raw: null };
    throw new Error("Kimi Code session state is not valid JSON", { cause: error });
  }
  const state = object(parsed, "Kimi Code session state");
  // The guide names title and creation/update timestamps but not their keys, so several documented
  // spellings are accepted and an unrecognized one stays unavailable rather than guessed.
  const first = (...keys: readonly string[]): string | null => {
    for (const key of keys) {
      const value = isoTimestamp(state[key]);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    createdAt: first("createdAt", "created_at", "createdTime", "created"),
    updatedAt: first("updatedAt", "updated_at", "updatedTime", "updated"),
    raw: parsed,
  };
}

/** Documented server event names that carry an occurrence AXtory counts. */
const CONTENT_EVENT = "ContentPart";
const TOOL_EVENTS = new Set(["ToolCall", "ToolResult"]);
const COMPACTION_EVENT = "CompactionBegin";

/** Read the event name from either documented JSON-RPC serialization of a tagged enum. */
function eventName(params: unknown): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.type === "string") return record.type;
  const keys = Object.keys(record);
  return keys.length === 1 && typeof keys[0] === "string" ? keys[0] : null;
}

function safePartType(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value) ? value : "unknown";
}

async function readWireEvents(path: string): Promise<{
  messages: AdditionalAiMessage[];
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_COMPACTION" | "UNKNOWN";
  raw: unknown;
}> {
  let body: string;
  try {
    const info = await stat(path);
    if (info.size > WIRE_LIMIT_BYTES) throw new Error("Kimi Code wire log exceeds the 64 MiB limit");
    body = await readFile(path, "utf8");
  } catch (error) {
    // A session directory without a main agent log carries no readable event stream. That is an
    // unknown view, not a session that held no messages.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { messages: [], coverage: "UNKNOWN", raw: null };
    }
    throw error;
  }
  const lines = body.split("\n").filter((line) => line.trim().length > 0);
  const messages: AdditionalAiMessage[] = [];
  const raw: unknown[] = [];
  let recognized = 0;
  let compacted = false;
  lines.forEach((line, index) => {
    let entry: Record<string, unknown>;
    try {
      entry = object(JSON.parse(line), "Kimi Code wire entry");
    } catch {
      return;
    }
    raw.push(entry);
    if (entry.jsonrpc !== "2.0" || typeof entry.method !== "string") return;
    if (entry.method === "prompt") {
      recognized += 1;
      messages.push({
        externalId: `prompt-${index}`, role: "USER", occurredAt: null,
        contentIdentity: sha256(canonicalJson(entry.params ?? null)), partTypes: ["prompt"],
      });
      return;
    }
    if (entry.method !== "event" && entry.method !== "request") return;
    const name = eventName(entry.params);
    if (name === null) return;
    if (name === COMPACTION_EVENT) {
      recognized += 1;
      compacted = true;
      return;
    }
    if (name === CONTENT_EVENT) {
      recognized += 1;
      const inner = eventPayload(entry.params, name);
      messages.push({
        externalId: `content-${index}`, role: "ASSISTANT", occurredAt: null,
        contentIdentity: sha256(canonicalJson(inner)), partTypes: [safePartType(readPartType(inner))],
      });
      return;
    }
    if (TOOL_EVENTS.has(name)) {
      recognized += 1;
      messages.push({
        externalId: `${name.toLowerCase()}-${index}`, role: "TOOL", occurredAt: null,
        contentIdentity: sha256(canonicalJson(eventPayload(entry.params, name))), partTypes: ["tool"],
      });
    }
  });
  // Lines exist but none matched a documented shape: the format moved. Reporting zero messages here
  // would present a format change as an empty session.
  if (lines.length > 0 && recognized === 0) {
    throw new Error("Kimi Code wire log contained no documented JSON-RPC event");
  }
  return {
    messages,
    coverage: compacted ? "PARTIAL_COMPACTION" : "COMPLETE_FOR_RETURNED_VIEW",
    raw,
  };
}

function eventPayload(params: unknown, name: string): unknown {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  return typeof record.type === "string" ? record : record[name] ?? null;
}

function readPartType(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  return (payload as Record<string, unknown>).kind ?? (payload as Record<string, unknown>).part_type;
}
