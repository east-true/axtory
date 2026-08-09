import type { NormalizedObservation } from "../../core/records.js";
import type { SemanticDocument } from "../../analysis/semantic-analyzer.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    const item = record(block);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  });
}

export function extractClaudeSemanticDocuments(
  rawPayload: unknown,
  observations: readonly NormalizedObservation[],
): SemanticDocument[] {
  const root = record(rawPayload);
  const fixtureSession = record(root?.session);
  const fixtureMessages = Array.isArray(fixtureSession?.messages) ? fixtureSession.messages : null;
  const officialMessages = Array.isArray(root?.messages) ? root.messages : null;
  const messages = fixtureMessages ?? officialMessages;
  if (!messages) throw new Error("raw payload is not a supported Claude history view");
  return messages.flatMap((message, index) => {
    const envelope = record(message);
    const isFixture = fixtureMessages !== null;
    const role = isFixture ? envelope?.role : envelope?.type;
    if (role !== "assistant") return [];
    const content = isFixture ? envelope?.blocks : record(envelope?.message)?.content;
    const text = textBlocks(content).join("\n").trim();
    if (!text) return [];
    const evidence = observations.find((item) => item.stableKey.startsWith(`message:${index}:`));
    if (!evidence) throw new Error("semantic input has no matching normalized message evidence");
    return [{ id: `assistant-message-${index}`, evidenceId: evidence.id, text }];
  });
}
