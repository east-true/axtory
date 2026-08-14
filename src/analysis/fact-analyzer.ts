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
  const partialContentView = projections.some((projection) =>
    projection.messageCoverage !== "COMPLETE_FOR_RETURNED_VIEW");
  const definitions = [
    { definition: METRIC_CATALOG["session.count"], evidence: flatten((item) => item.sessionEvidenceIds),
      affectedByContentCoverage: false },
    { definition: METRIC_CATALOG["message.count"], evidence: flatten((item) => item.messageEvidenceIds),
      affectedByContentCoverage: true },
    { definition: METRIC_CATALOG["tool.invocation.count"], evidence: flatten((item) => item.toolInvocationEvidenceIds),
      affectedByContentCoverage: true },
  ] as const;
  const available = definitions.map(({ definition, evidence, affectedByContentCoverage }) => {
    const partial = affectedByContentCoverage && partialContentView;
    return {
      id: stableId("analysis", { analysisRunId, key: definition.key }),
      analysisRunId,
      key: definition.key,
      recordType: "METRIC",
      derivation: "CALCULATED",
      value: evidence.length,
      unit: definition.unit,
      availability: partial ? "PARTIAL" : "AVAILABLE",
      reason: partial
        ? "One or more session views are partial, so this count covers only the returned evidence."
        : null,
      evidenceIds: evidence,
      evidenceStatus: "PRESENT",
    } satisfies AnalysisRecord;
  });
  const unavailable = [
    {
      definition: METRIC_CATALOG["agent.assertion.count"],
      availability: "NOT_SUPPORTED" as const,
      reason: "The rule-based fact analyzer does not classify free-form assistant content as assertions.",
    },
    {
      definition: METRIC_CATALOG["usage.input.tokens"],
      availability: "NOT_COLLECTED" as const,
      reason: "Session history views are not used as authoritative token telemetry.",
    },
    {
      definition: METRIC_CATALOG["usage.output.tokens"],
      availability: "NOT_COLLECTED" as const,
      reason: "Session history views are not used as authoritative token telemetry.",
    },
  ].map(({ definition, availability, reason }) => ({
    id: stableId("analysis", { analysisRunId, key: definition.key }),
    analysisRunId,
    key: definition.key,
    recordType: "METRIC" as const,
    derivation: definition.derivation,
    value: null,
    unit: definition.unit,
    availability,
    reason,
    evidenceIds: [],
    evidenceStatus: "PRESENT",
  } satisfies AnalysisRecord));
  return [...available, ...unavailable];
}
