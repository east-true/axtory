import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { extractClaudeSemanticDocuments } from "../connectors/claude/semantic-input.js";
import { extractCodexSemanticDocuments } from "../connectors/codex/semantic-input.js";
import { extractAdditionalAiSemanticDocuments } from "../connectors/additional-ai/semantic-input.js";
import { ContentAddressedBlobStore } from "../core/blob-store.js";
import { ensureAxtoryDataDirectory } from "../core/data-directory.js";
import { AxtoryDatabase } from "../core/storage.js";
import { analyzeRuleSemantics, RULE_SEMANTIC_ANALYZER_VERSION } from "./semantic-analyzer.js";

export interface SemanticAnalysisSummary {
  analysisRunId: string;
  analyzer: "RULE";
  derivation: "INFERRED";
  documentsAnalyzed: number;
  assertionsFound: number;
  categories: Readonly<Record<string, number>>;
  limitation: string;
}

export async function runRuleSemanticAnalysis(options: {
  dataDirectory: string;
  revisionId: string;
  allowConversationContent: boolean;
  now?: () => Date;
  randomId?: () => string;
}): Promise<SemanticAnalysisSummary> {
  if (!options.allowConversationContent) {
    throw new Error("semantic analysis requires explicit conversation-content consent");
  }
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const database = new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
  const analysisRunId = `analysis_${randomId()}`;
  let started = false;
  try {
    const raw = database.rawObservationForRevision(options.revisionId);
    if (!raw) throw new Error("raw evidence is not retained for this revision");
    if (raw.dataClassification !== "CONVERSATION_CONTENT") {
      throw new Error("revision is not classified as conversation content");
    }
    const bytes = await new ContentAddressedBlobStore(join(dataDirectory, "blobs"))
      .read(raw.payloadReference, 64 * 1024 * 1024);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new Error("raw semantic input is not valid JSON", { cause: error });
    }
    const observations = database.observationsForRevision(options.revisionId);
    const documents = raw.observationType === "CODEX_THREAD_VIEW"
      ? extractCodexSemanticDocuments(payload, observations)
      : raw.observationType === "ADDITIONAL_AI_VIEW"
        ? extractAdditionalAiSemanticDocuments(payload, observations)
        : extractClaudeSemanticDocuments(payload, observations);
    database.startAnalysisRun({
      id: analysisRunId, analyzerType: "RULE_SEMANTIC_ANALYZER",
      analyzerVersion: RULE_SEMANTIC_ANALYZER_VERSION,
      inputRevisionIds: [options.revisionId], startedAt: now().toISOString(),
    });
    started = true;
    const records = analyzeRuleSemantics(analysisRunId, documents);
    database.transaction(() => database.insertAnalysisRecords(records));
    database.finishAnalysisRun(analysisRunId, "COMPLETED", now().toISOString());
    const categories: Record<string, number> = {};
    for (const record of records) {
      const category = (record.value as { category: string }).category;
      categories[category] = (categories[category] ?? 0) + 1;
    }
    return {
      analysisRunId, analyzer: "RULE", derivation: "INFERRED",
      documentsAnalyzed: documents.length, assertionsFound: records.length, categories,
      limitation: "Rule matches identify unverified assertions, not proof that the asserted event occurred.",
    };
  } catch (error) {
    if (started) database.finishAnalysisRun(analysisRunId, "FAILED", now().toISOString(), "ANALYSIS_ERROR");
    throw error;
  } finally {
    database.close();
  }
}
