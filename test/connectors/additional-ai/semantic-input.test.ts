import test from "node:test";
import assert from "node:assert/strict";

import { extractAdditionalAiSemanticDocuments } from "../../../src/connectors/additional-ai/semantic-input.js";
import type { NormalizedObservation } from "../../../src/core/records.js";

const observation: NormalizedObservation = {
  id: "evidence", sourceRevisionId: "revision", stableKey: "message:0:identity", kind: "CONTENT",
  derivation: "OBSERVED", provenance: "OFFICIAL_API", dataClassification: "CONVERSATION_CONTENT",
  occurredAt: null, timeQuality: "UNKNOWN", payload: {},
};

test("OpenCode semantic input maps assistant text to normalized evidence only", () => {
  const raw = {
    provider: "OPENCODE",
    view: { messages: [
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Tests passed." }, { type: "tool", state: {} }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "private user prompt" }] },
    ] },
  };
  const documents = extractAdditionalAiSemanticDocuments(raw, [observation]);
  assert.deepEqual(documents, [{ id: "opencode-assistant-message-0", evidenceId: "evidence", text: "Tests passed." }]);
  // Aider's Markdown has no documented message schema, so it stays unsupported even though the
  // provider list has since grown beyond OpenCode.
  assert.throws(() => extractAdditionalAiSemanticDocuments({ provider: "AIDER", view: {} }, []),
    /supports only providers with a documented message schema/u);
});
