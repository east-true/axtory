import test from "node:test";
import assert from "node:assert/strict";

import { analyzeFacts } from "../../src/analysis/fact-analyzer.js";
import type { SessionProjection } from "../../src/projections/session.js";

function projection(coverage: SessionProjection["messageCoverage"]): SessionProjection {
  return {
    sourceRevisionId: "revision_1",
    sessionEvidenceIds: ["session_1"],
    messageEvidenceIds: ["message_1"],
    toolInvocationEvidenceIds: ["tool_1"],
    messageCoverage: coverage,
  };
}

test("partial session views keep message and tool counts partial instead of fully available", () => {
  const records = analyzeFacts("analysis_partial", [projection("PARTIAL_PAGINATION")]);
  const session = records.find((item) => item.key === "session.count");
  const messages = records.find((item) => item.key === "message.count");
  const tools = records.find((item) => item.key === "tool.invocation.count");

  assert.equal(session?.availability, "AVAILABLE", "the session snapshot itself is still present");
  assert.equal(session?.value, 1);
  assert.equal(messages?.availability, "PARTIAL");
  assert.equal(messages?.value, 1);
  assert.match(messages?.reason ?? "", /partial.*returned evidence/iu);
  assert.equal(tools?.availability, "PARTIAL");
  assert.equal(tools?.value, 1);
});

test("complete session views keep occurrence counts available", () => {
  const records = analyzeFacts("analysis_complete", [projection("COMPLETE_FOR_RETURNED_VIEW")]);
  assert.equal(records.find((item) => item.key === "message.count")?.availability, "AVAILABLE");
  assert.equal(records.find((item) => item.key === "tool.invocation.count")?.availability, "AVAILABLE");
});
