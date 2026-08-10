import test from "node:test";
import assert from "node:assert/strict";

import { extractKimiSemanticDocuments } from "../../../src/connectors/additional-ai/kimi-semantic-input.js";
import { normalizeAdditionalAiSession } from "../../../src/connectors/additional-ai/normalizer.js";
import type { AdditionalAiMessage, AdditionalAiSessionView } from "../../../src/connectors/additional-ai/types.js";
import { sha256 } from "../../../src/core/canonical-json.js";

const entry = (params: unknown, method = "event") => ({ jsonrpc: "2.0", method, params });

/** Build the canonical observations the collector would have stored for these wire entries. */
function observationsFor(wire: readonly unknown[]) {
  const messages = wire.flatMap((value, index): AdditionalAiMessage[] => {
    const item = value as { method?: string; params?: { type?: string } };
    if (item.method === "prompt") {
      return [{ externalId: `prompt-${index}`, role: "USER", occurredAt: null, contentIdentity: sha256("u"), partTypes: ["prompt"] }];
    }
    const type = item.params?.type;
    if (type === "ContentPart") {
      return [{ externalId: `content-${index}`, role: "ASSISTANT", occurredAt: null, contentIdentity: sha256("a"), partTypes: ["text"] }];
    }
    if (type === "ToolCall" || type === "ToolResult") {
      return [{ externalId: `${String(type).toLowerCase()}-${index}`, role: "TOOL", occurredAt: null, contentIdentity: sha256("t"), partTypes: ["tool"] }];
    }
    return [];
  });
  const view = {
    summary: {
      provider: "KIMI_CODE", scopeIdentity: "scope", externalId: "01K9ZC7Q",
      createdAt: null, sourceUpdatedAt: null,
    },
    coverage: "COMPLETE_FOR_RETURNED_VIEW", messages,
    rawPayload: null, provenance: "DOCUMENTED_STORAGE", dataClassification: "CONVERSATION_CONTENT",
  } as unknown as AdditionalAiSessionView;
  return normalizeAdditionalAiSession(view, "revision-1");
}

test("only assistant text becomes an assertion candidate", () => {
  const wire = [
    entry({ text: "fix the build" }, "prompt"),
    entry({ type: "ContentPart", kind: "think", text: "internal reasoning" }),
    entry({ type: "ToolCall", name: "edit_file" }),
    entry({ type: "ContentPart", kind: "text", text: "I implemented the change." }),
  ];
  const documents = extractKimiSemanticDocuments({ wire }, observationsFor(wire));

  // Reasoning is not something the agent stated, and a tool call carries no claim.
  assert.equal(documents.length, 1);
  assert.equal(documents[0]!.text, "I implemented the change.");
});

test("a document points at the evidence the normalizer already created", () => {
  const wire = [
    entry({ text: "prompt" }, "prompt"),
    entry({ type: "ToolCall", name: "edit_file" }),
    entry({ type: "ContentPart", kind: "text", text: "done" }),
  ];
  const observations = observationsFor(wire);
  const documents = extractKimiSemanticDocuments({ wire }, observations);

  // The assistant message is the third canonical message, so its evidence must be message index 2
  // rather than a second numbering invented by the extractor.
  const expected = observations.find((item) => item.stableKey.startsWith("message:2:"));
  assert.ok(expected);
  assert.equal(documents[0]!.evidenceId, expected.id);
});

test("a session with no readable event stream fails instead of reporting no claims", () => {
  assert.throws(() => extractKimiSemanticDocuments({ wire: null }, []), /no agent event stream/u);
  assert.throws(() => extractKimiSemanticDocuments({}, []), /no agent event stream/u);
});

test("content parts that expose no readable text fail rather than read as silence", () => {
  const wire = [entry({ type: "ContentPart", kind: "text", unexpected_field: "moved" })];
  assert.throws(
    () => extractKimiSemanticDocuments({ wire }, observationsFor(wire)),
    /no readable text field/u,
  );
});

test("a stream with no content parts at all yields no documents without failing", () => {
  const wire = [entry({ text: "prompt" }, "prompt"), entry({ type: "ToolCall", name: "edit_file" })];
  assert.deepEqual(extractKimiSemanticDocuments({ wire }, observationsFor(wire)), []);
});

test("compaction does not shift the message positions evidence is keyed by", () => {
  const wire = [
    entry({ text: "prompt" }, "prompt"),
    entry({ type: "CompactionBegin" }),
    entry({ type: "ContentPart", kind: "text", text: "resumed and finished" }),
  ];
  const observations = observationsFor(wire);
  const documents = extractKimiSemanticDocuments({ wire }, observations);
  const expected = observations.find((item) => item.stableKey.startsWith("message:1:"));
  assert.ok(expected);
  assert.equal(documents[0]!.evidenceId, expected.id);
});
