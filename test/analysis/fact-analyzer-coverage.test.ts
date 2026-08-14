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

  assert.equal(session?.availability, "AVAILABLE", "the complete source set still contains this session snapshot");
  assert.equal(session?.value, 1);
  assert.equal(messages?.availability, "PARTIAL");
  assert.equal(messages?.value, 1);
  assert.match(messages?.reason ?? "", /partial.*returned evidence/iu);
  assert.equal(tools?.availability, "PARTIAL");
  assert.equal(tools?.value, 1);
});

test("partial source enumeration makes every count over that source set partial", () => {
  const records = analyzeFacts(
    "analysis_partial_set",
    [projection("COMPLETE_FOR_RETURNED_VIEW")],
    { sourceSetComplete: false },
  );
  for (const key of ["session.count", "message.count", "tool.invocation.count"]) {
    const record = records.find((item) => item.key === key);
    assert.equal(record?.availability, "PARTIAL", `${key} cannot be complete when a source is omitted`);
    assert.match(record?.reason ?? "", /source enumeration is partial/iu);
  }
});

test("complete source and content views keep occurrence counts available", () => {
  const records = analyzeFacts(
    "analysis_complete",
    [projection("COMPLETE_FOR_RETURNED_VIEW")],
    { sourceSetComplete: true },
  );
  assert.equal(records.find((item) => item.key === "session.count")?.availability, "AVAILABLE");
  assert.equal(records.find((item) => item.key === "message.count")?.availability, "AVAILABLE");
  assert.equal(records.find((item) => item.key === "tool.invocation.count")?.availability, "AVAILABLE");
});
