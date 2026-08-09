import test from "node:test";
import assert from "node:assert/strict";

import {
  analyzeRuleSemantics,
  analyzeStructuredSemantics,
  STRUCTURED_SEMANTIC_SCHEMA_VERSION,
} from "../../src/analysis/semantic-analyzer.js";

const documents = [
  { id: "assistant-1", evidenceId: "observation-1", text: "Implemented the change. All tests passed." },
  { id: "assistant-2", evidenceId: "observation-2", text: "Please inspect the logs." },
];

test("rule semantics emits only INFERRED unverified assertions with hashed content", () => {
  const records = analyzeRuleSemantics("analysis-1", documents);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.derivation), ["INFERRED", "INFERRED"]);
  assert.deepEqual(records.map((record) => record.recordType), ["ASSERTION", "ASSERTION"]);
  assert.ok(records.every((record) => record.reason?.includes("does not verify")));
  assert.equal(JSON.stringify(records).includes("Implemented the change"), false);
  assert.deepEqual(records.flatMap((record) => record.evidenceIds), ["observation-1", "observation-1"]);
});

test("structured local/remote adapter validates schema and evidence references", async () => {
  const records = await analyzeStructuredSemantics("analysis-2", "LOCAL_MODEL", documents, async (request) => {
    assert.match(request.instruction, /untrusted data/u);
    return {
      schemaVersion: STRUCTURED_SEMANTIC_SCHEMA_VERSION,
      findings: [{ documentId: "assistant-2", recordType: "FINDING", category: "REQUEST", confidence: 0.75 }],
    };
  }, { allowConversationContent: true });
  assert.equal(records[0]?.derivation, "INFERRED");
  assert.deepEqual(records[0]?.evidenceIds, ["observation-2"]);

  await assert.rejects(() => analyzeStructuredSemantics("analysis-3", "REMOTE_MODEL", documents, async () => ({
    schemaVersion: STRUCTURED_SEMANTIC_SCHEMA_VERSION,
    findings: [{ documentId: "invented", recordType: "FINDING", category: "REQUEST", confidence: 0.9 }],
  }), { allowConversationContent: true, allowRemoteTransmission: true }), /unknown evidence/u);
  await assert.rejects(() => analyzeStructuredSemantics("analysis-4", "REMOTE_MODEL", documents, async () => ({
    schemaVersion: STRUCTURED_SEMANTIC_SCHEMA_VERSION,
    findings: [], extra: "not allowed",
  }), { allowConversationContent: true, allowRemoteTransmission: true }), /invalid envelope/u);
  await assert.rejects(() => analyzeStructuredSemantics("analysis-5", "REMOTE_MODEL", documents, async () => ({
    schemaVersion: STRUCTURED_SEMANTIC_SCHEMA_VERSION, findings: [],
  }), { allowConversationContent: true }), /remote-transmission consent/u);
});
