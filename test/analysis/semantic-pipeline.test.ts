import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { runRuleSemanticAnalysis } from "../../src/analysis/semantic-pipeline.js";
import { executeSelectiveDeletion } from "../../src/core/deletion.js";
import { runWalkingSkeleton } from "../../src/core/pipeline.js";

test("rule semantic pipeline requires opt-in, persists inferred records, and refuses removed raw evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-semantic-"));
  try {
    const collected = await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory: directory,
      jsonOutputPath: join(directory, "output.json"), now: () => new Date("2026-08-09T00:00:00.000Z"),
      randomId: () => "semantic-fixture",
    });
    await assert.rejects(() => runRuleSemanticAnalysis({
      dataDirectory: directory, revisionId: collected.output.sourceRevisionId,
      allowConversationContent: false,
    }), /explicit conversation-content consent/u);
    const summary = await runRuleSemanticAnalysis({
      dataDirectory: directory, revisionId: collected.output.sourceRevisionId,
      allowConversationContent: true, now: () => new Date("2026-08-09T01:00:00.000Z"),
      randomId: () => "semantic-analysis",
    });
    assert.equal(summary.derivation, "INFERRED");
    assert.equal(summary.documentsAnalyzed, 1);
    assert.equal(summary.assertionsFound, 1);
    const verifier = new DatabaseSync(collected.databasePath, { readOnly: true });
    try {
      const row = verifier.prepare(`SELECT derivation, record_type, value_json
        FROM analysis_records WHERE analysis_run_id = 'analysis_semantic-analysis'`).get() as
        { derivation: string; record_type: string; value_json: string };
      assert.equal(row.derivation, "INFERRED");
      assert.equal(row.record_type, "ASSERTION");
      assert.equal(row.value_json.includes("synthetic artifact was created"), false);
    } finally {
      verifier.close();
    }
    await executeSelectiveDeletion({
      dataDirectory: directory, mode: "DELETE_RAW_ONLY",
      target: { revisionIds: [collected.output.sourceRevisionId] }, confirmation: "DELETE_RAW_ONLY",
    });
    await assert.rejects(() => runRuleSemanticAnalysis({
      dataDirectory: directory, revisionId: collected.output.sourceRevisionId,
      allowConversationContent: true,
    }), /raw evidence is not retained/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
