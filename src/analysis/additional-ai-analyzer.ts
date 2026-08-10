import { analyzeFacts, FACT_ANALYZER_VERSION } from "./fact-analyzer.js";
import { stableId } from "../core/canonical-json.js";
import type { AnalysisRecord } from "../core/records.js";
import type { AdditionalAiProvider } from "../connectors/additional-ai/types.js";
import type { SessionProjection } from "../projections/session.js";

export const ADDITIONAL_AI_FACT_ANALYZER_VERSION = `${FACT_ANALYZER_VERSION}+additional-ai-availability/1`;

export function analyzeAdditionalAiFacts(
  analysisRunId: string,
  provider: AdditionalAiProvider,
  projections: readonly SessionProjection[],
): AnalysisRecord[] {
  const records = analyzeFacts(analysisRunId, projections);
  // Providers with a documented machine-readable history keep the message and tool counts the
  // shared fact analyzer produced. The rest cannot support them and say so with a reason.
  if (provider === "OPENCODE" || provider === "KIMI_CODE") return records;
  const availability = provider === "AIDER" ? "NOT_SUPPORTED" as const : "NOT_COLLECTED" as const;
  const reason = provider === "AIDER"
    ? "Aider's documented Markdown history has no stable machine-readable message or tool schema."
    : `${provider} exposes session listing but no non-mutating structured history export.`;
  return records.map((record) => {
    if (record.key !== "message.count" && record.key !== "tool.invocation.count") return record;
    return {
      ...record,
      id: stableId("analysis", { analysisRunId, key: record.key }),
      value: null,
      availability,
      reason,
      evidenceIds: [],
    };
  });
}
