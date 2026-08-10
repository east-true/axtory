import test from "node:test";
import assert from "node:assert/strict";

import { analyzeAdditionalAiFacts } from "../../../src/analysis/additional-ai-analyzer.js";
import { normalizeAdditionalAiSession } from "../../../src/connectors/additional-ai/normalizer.js";
import type { AdditionalAiSessionView } from "../../../src/connectors/additional-ai/types.js";
import { projectSession } from "../../../src/projections/session.js";

const scopeIdentity = "d".repeat(64);

test("additional AI normalization keeps content out and counts explicit OpenCode tool parts", () => {
  const secret = "PRIVATE-NORMALIZED-CONTENT";
  const view: AdditionalAiSessionView = {
    summary: { provider: "OPENCODE", scopeIdentity, externalId: "ses_1234", createdAt: null, sourceUpdatedAt: null },
    coverage: "COMPLETE_FOR_RETURNED_VIEW",
    messages: [{ externalId: "msg_1234", role: "ASSISTANT", occurredAt: null,
      contentIdentity: "e".repeat(64), partTypes: ["text", "tool"] }],
    rawPayload: { content: secret }, provenance: "OFFICIAL_API", dataClassification: "CONVERSATION_CONTENT",
  };
  const observations = normalizeAdditionalAiSession(view, "revision");
  assert.equal(JSON.stringify(observations).includes(secret), false);
  const projection = projectSession(observations);
  assert.equal(projection.messageEvidenceIds.length, 1);
  assert.equal(projection.toolInvocationEvidenceIds.length, 1);
  const openCode = analyzeAdditionalAiFacts("run-open", "OPENCODE", [projection]);
  const gemini = analyzeAdditionalAiFacts("run-gemini", "GEMINI_CLI", [projection]);
  assert.equal(openCode.find((item) => item.key === "message.count")?.value, 1);
  assert.equal(gemini.find((item) => item.key === "message.count")?.availability, "NOT_COLLECTED");
  assert.equal(gemini.find((item) => item.key === "message.count")?.value, null);
});
