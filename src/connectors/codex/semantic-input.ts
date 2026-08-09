import type { SemanticDocument } from "../../analysis/semantic-analyzer.js";
import type { NormalizedObservation } from "../../core/records.js";

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function extractCodexSemanticDocuments(
  rawPayload: unknown,
  observations: readonly NormalizedObservation[],
): SemanticDocument[] {
  const thread = object(object(rawPayload)?.thread);
  if (!thread || !Array.isArray(thread.turns)) throw new Error("raw payload is not a Codex thread view");
  const documents: SemanticDocument[] = [];
  thread.turns.forEach((turnValue, turnIndex) => {
    const turn = object(turnValue);
    if (!turn || !Array.isArray(turn.items)) return;
    turn.items.forEach((itemValue, itemIndex) => {
      const item = object(itemValue);
      if (item?.type !== "agentMessage" || typeof item.text !== "string" || !item.text.trim()) return;
      const evidence = observations.find((candidate) =>
        candidate.stableKey.startsWith(`message:${turnIndex}:${itemIndex}:`));
      if (!evidence) throw new Error("semantic input has no matching normalized Codex message evidence");
      documents.push({
        id: `assistant-message-${turnIndex}-${itemIndex}`,
        evidenceId: evidence.id,
        text: item.text,
      });
    });
  });
  return documents;
}
