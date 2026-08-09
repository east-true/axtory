import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectAdditionalAiSource } from "../../../src/connectors/additional-ai/collector.js";
import { runRuleSemanticAnalysis } from "../../../src/analysis/semantic-pipeline.js";
import type { AdditionalAiDiscovery } from "../../../src/connectors/additional-ai/discovery.js";
import type { AdditionalAiSourceApi } from "../../../src/connectors/additional-ai/types.js";
import { available, unavailable } from "../../../src/core/model.js";
import { AxtoryDatabase } from "../../../src/core/storage.js";

const scopeIdentity = "f".repeat(64);

function discovery(): AdditionalAiDiscovery {
  return {
    provider: "OPENCODE",
    environment: { id: "environment", type: "LINUX", os: "linux", architecture: "x64", homeDirectory: unavailable("REDACTED", "not retained") },
    sourceProfile: { id: "profile", sourceType: "ADDITIONAL_AI", environmentId: "environment",
      dataRoot: unavailable("REDACTED", "not retained"), executablePath: available("opencode"), activeVersion: available("1.0.0") },
    capabilityAssessment: { sourceProfileId: "profile", assessedAt: "2026-08-10T00:00:00.000Z", capabilities: [
      { key: "additional_ai.installation", availability: "AVAILABLE", evidence: [] },
      { key: "additional_ai.session_enumeration", availability: "AVAILABLE", evidence: [] },
      { key: "additional_ai.session_content", availability: "AVAILABLE", evidence: [] },
    ] },
  };
}

test("additional AI collection is incremental and exports no conversation content", async () => {
  const secret = "PRIVATE-COLLECTED-CONTENT";
  const summary = { provider: "OPENCODE" as const, scopeIdentity, externalId: "ses_1234",
    createdAt: "2026-08-09T00:00:00.000Z", sourceUpdatedAt: "2026-08-10T00:00:00.000Z" };
  const api: AdditionalAiSourceApi = {
    provider: "OPENCODE", scopeIdentity,
    async listSessions() { return { items: [summary], coverage: "COMPLETE_FOR_RETURNED_VIEW" }; },
    async readSession() { return {
      summary, coverage: "COMPLETE_FOR_RETURNED_VIEW", provenance: "OFFICIAL_API",
      dataClassification: "CONVERSATION_CONTENT", rawPayload: {
        info: { id: "ses_1234" },
        messages: [{ info: { role: "assistant" }, parts: [{ type: "text", text: `Tests passed. ${secret}` }] }],
      },
      messages: [{ externalId: "msg_1234", role: "ASSISTANT", occurredAt: null,
        contentIdentity: "a".repeat(64), partTypes: ["text", "tool"] }],
    }; },
  };
  const directory = await mkdtemp(join(tmpdir(), "axtory-additional-collector-"));
  try {
    let sequence = 0;
    const run = () => collectAdditionalAiSource(api, discovery(), {
      dataDirectory: directory, jsonOutputPath: join(directory, "output.json"),
      now: () => new Date("2026-08-10T00:00:00.000Z"), randomId: () => `id-${++sequence}`,
    });
    const first = await run();
    const second = await run();
    assert.equal(first.sessions.revisionsCreated, 1);
    assert.equal(second.sessions.revisionsCreated, 0);
    assert.equal(second.sessions.revisionsUnchanged, 1);
    assert.equal(second.metrics.find((item) => item.key === "message.count")?.value, 1);
    assert.equal((await readFile(join(directory, "output.json"), "utf8")).includes(secret), false);
    const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
    let revisionId = "";
    try {
      assert.equal(database.count("source_revisions"), 1);
      assert.equal(database.count("raw_observations"), 1);
      assert.equal(database.count("analysis_runs"), 2);
      revisionId = database.inventory().sources[0]!.revisions[0]!.revisionId;
    } finally {
      database.close();
    }
    const semantic = await runRuleSemanticAnalysis({
      dataDirectory: directory, revisionId, allowConversationContent: true,
      now: () => new Date("2026-08-10T00:00:00.000Z"), randomId: () => "semantic-id",
    });
    assert.equal(semantic.documentsAnalyzed, 1);
    assert.equal(semantic.assertionsFound, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
