import type { SemanticDocument } from "../../analysis/semantic-analyzer.js";
import type { NormalizedObservation } from "../../core/records.js";
import { object } from "./types.js";

/**
 * Recover assistant text from a stored Kimi Code raw view.
 *
 * The raw view keeps the wire entries in the order the adapter read them, and the adapter derives
 * one canonical message per recognized entry in that same order. Re-walking the entries with the
 * same classification therefore reproduces the message positions the normalizer used, so a document
 * can be tied to the evidence id that already exists rather than to a second, parallel numbering.
 *
 * Only `ContentPart` text is analyzed. `think` parts are model reasoning rather than something the
 * agent stated, and media parts carry no assertion, so neither becomes an assertion candidate.
 */
export function extractKimiSemanticDocuments(
  view: Record<string, unknown>,
  observations: readonly NormalizedObservation[],
): SemanticDocument[] {
  const wire = view.wire;
  if (wire === null || wire === undefined) {
    // The session has no readable event stream, which the collector already recorded as UNKNOWN
    // coverage. Returning no documents would present that as a session that made no claims.
    throw new Error("Kimi Code raw view has no agent event stream to analyze");
  }
  if (!Array.isArray(wire)) throw new Error("Kimi Code raw view wire must be an array");

  const documents: SemanticDocument[] = [];
  let messagePosition = 0;
  let contentParts = 0;
  for (const entryValue of wire) {
    const entry = object(entryValue, "Kimi Code wire entry");
    if (entry.jsonrpc !== "2.0" || typeof entry.method !== "string") continue;

    if (entry.method === "prompt") {
      messagePosition += 1;
      continue;
    }
    if (entry.method !== "event" && entry.method !== "request") continue;
    const name = eventName(entry.params);
    if (name === null || name === "CompactionBegin") continue;
    if (name !== "ContentPart" && name !== "ToolCall" && name !== "ToolResult") continue;

    const position = messagePosition;
    messagePosition += 1;
    if (name !== "ContentPart") continue;

    contentParts += 1;
    const text = readText(eventPayload(entry.params, name));
    if (text === null) continue;
    const evidence = observations.find((candidate) => candidate.stableKey.startsWith(`message:${position}:`));
    if (!evidence) throw new Error("semantic input has no matching normalized Kimi Code message evidence");
    documents.push({ id: `kimi-assistant-message-${position}`, evidenceId: evidence.id, text });
  }

  // Assistant parts exist but none exposed text under a recognized key: the payload shape moved.
  // Reporting zero assertions here would read as an agent that asserted nothing.
  if (contentParts > 0 && documents.length === 0) {
    throw new Error("Kimi Code content parts exposed no readable text field");
  }
  return documents;
}

function eventName(params: unknown): string | null {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  if (typeof record.type === "string") return record.type;
  const keys = Object.keys(record);
  return keys.length === 1 && typeof keys[0] === "string" ? keys[0] : null;
}

function eventPayload(params: unknown, name: string): unknown {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const record = params as Record<string, unknown>;
  return typeof record.type === "string" ? record : record[name] ?? null;
}

/**
 * The Wire reference names the `text` variant of `ContentPart` but not the key holding its string,
 * so a small set of spellings is accepted. An unrecognized shape yields null and is counted as an
 * unreadable part rather than as an empty message.
 */
function readText(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const kind = record.kind ?? record.part_type ?? record.partType;
  if (typeof kind === "string" && kind !== "text") return null;
  for (const key of ["text", "content", "value"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}
