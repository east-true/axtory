import { stableId } from "../core/canonical-json.js";
import type { AnalysisRecord } from "../core/records.js";
import type { SessionProjection } from "../projections/session.js";
import { METRIC_CATALOG } from "./metric-catalog.js";

export const FACT_ANALYZER_VERSION = "fact-counts/1";

export function analyzeFacts(
  analysisRunId: string,
  projections: readonly SessionProjection[],
): AnalysisRecord[] {
  const flatten = (select: (projection: SessionProjection) => readonly string[]) =>
    projections.flatMap((projection) => select(projection));
  const definitions = [
    { definition: METRIC_CATALOG["session.count"], evidence: flatten((item) => item.sessionEvidenceIds) },
    { definition: METRIC_CATALOG["message.count"], evidence: flatten((item) => item.messageEvidenceIds) },
    { definition: METRIC_CATALOG["tool.invocation.count"], evidence: flatten((item) => item.toolInvocationEvidenceIds) },
  ] as const;
  return definitions.map(({ definition, evidence }) => {
    return {
      id: stableId("analysis", { analysisRunId, key: definition.key }),
      analysisRunId,
      key: definition.key,
      recordType: "METRIC",
      derivation: "CALCULATED",
      value: evidence.length,
      unit: definition.unit,
      availability: "AVAILABLE",
      reason: null,
      evidenceIds: evidence,
    } satisfies AnalysisRecord;
  });
}
