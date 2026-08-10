import type { SemanticDocument } from "../../analysis/semantic-analyzer.js";
import type { NormalizedObservation } from "../../core/records.js";
import { extractKimiSemanticDocuments } from "./kimi-semantic-input.js";
import { object } from "./types.js";

export function extractAdditionalAiSemanticDocuments(
  rawPayload: unknown,
  observations: readonly NormalizedObservation[],
): SemanticDocument[] {
  const envelope = object(rawPayload, "additional AI raw view");
  if (envelope.provider === "KIMI_CODE") {
    return extractKimiSemanticDocuments(object(envelope.view, "Kimi Code raw view"), observations);
  }
  if (envelope.provider !== "OPENCODE") {
    throw new Error("semantic analysis supports only providers with a documented message schema");
  }
  const view = object(envelope.view, "OpenCode raw view");
  if (!Array.isArray(view.messages)) throw new Error("OpenCode raw view messages must be an array");
  return view.messages.flatMap((messageValue, messageIndex): SemanticDocument[] => {
    const message = object(messageValue, "OpenCode semantic message");
    const info = object(message.info, "OpenCode semantic message info");
    if (info.role !== "assistant" || !Array.isArray(message.parts)) return [];
    const text = message.parts.flatMap((partValue) => {
      const part = object(partValue, "OpenCode semantic part");
      return part.type === "text" && typeof part.text === "string" && part.text.trim() ? [part.text] : [];
    }).join("\n");
    if (!text) return [];
    const evidence = observations.find((candidate) => candidate.stableKey.startsWith(`message:${messageIndex}:`));
    if (!evidence) throw new Error("semantic input has no matching normalized OpenCode message evidence");
    return [{ id: `opencode-assistant-message-${messageIndex}`, evidenceId: evidence.id, text }];
  });
}
