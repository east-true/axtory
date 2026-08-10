import { stableId } from "../core/canonical-json.js";
import type { AnalysisRecord } from "../core/records.js";
import type { WorkArtifactKind } from "../connectors/work-systems/types.js";
import type { WorkArtifactProjection } from "../projections/work-artifact.js";
import { WORK_METRIC_CATALOG } from "./metric-catalog.js";

export const WORK_FACT_ANALYZER_VERSION = "work-facts/1";

interface Definition {
  key: keyof typeof WORK_METRIC_CATALOG;
  kind: WorkArtifactKind;
  status?: WorkArtifactProjection["statusCategory"];
}

const DEFINITIONS: readonly Definition[] = [
  { key: "work.change_request.count", kind: "CHANGE_REQUEST" },
  { key: "work.change_request.merged.count", kind: "CHANGE_REQUEST", status: "MERGED" },
  { key: "work.ci_run.count", kind: "CI_RUN" },
  { key: "work.ci_run.succeeded.count", kind: "CI_RUN", status: "SUCCEEDED" },
  { key: "work.ci_run.failed.count", kind: "CI_RUN", status: "FAILED" },
  { key: "work.deployment.count", kind: "DEPLOYMENT" },
  { key: "work.deployment.succeeded.count", kind: "DEPLOYMENT", status: "SUCCEEDED" },
  { key: "work.deployment.failed.count", kind: "DEPLOYMENT", status: "FAILED" },
  { key: "work.item.count", kind: "WORK_ITEM" },
  { key: "work.item.completed.count", kind: "WORK_ITEM", status: "COMPLETED" },
];

export function analyzeWorkFacts(
  analysisRunId: string,
  projections: readonly WorkArtifactProjection[],
  supportedKinds: readonly WorkArtifactKind[],
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION",
): AnalysisRecord[] {
  return DEFINITIONS.map((entry) => {
    const definition = WORK_METRIC_CATALOG[entry.key];
    if (!supportedKinds.includes(entry.kind)) {
      return {
        id: stableId("analysis", { analysisRunId, key: entry.key }), analysisRunId,
        key: entry.key, recordType: "METRIC", derivation: "CALCULATED", value: null,
        unit: definition.unit, availability: "NOT_SUPPORTED",
        reason: `${entry.kind} is not exposed by this work-system connector.`,
        evidenceIds: [], evidenceStatus: "PRESENT",
      } satisfies AnalysisRecord;
    }
    const evidence = projections.filter((item) => item.artifactKind === entry.kind &&
      (entry.status === undefined || item.statusCategory === entry.status))
      .map((item) => item.artifactEvidenceId);
    return {
      id: stableId("analysis", { analysisRunId, key: entry.key }), analysisRunId,
      key: entry.key, recordType: "METRIC", derivation: "CALCULATED", value: evidence.length,
      unit: definition.unit,
      availability: coverage === "PARTIAL_PAGINATION" ? "PARTIAL" : "AVAILABLE",
      reason: coverage === "PARTIAL_PAGINATION" ? "Count covers only the bounded returned view." : null,
      evidenceIds: evidence, evidenceStatus: "PRESENT",
    } satisfies AnalysisRecord;
  });
}
