import { stableId } from "../core/canonical-json.js";
import type { AnalysisRecord, NormalizedObservation } from "../core/records.js";
import { OTEL_METRIC_CATALOG } from "./metric-catalog.js";

export const OTEL_FACT_ANALYZER_VERSION = "claude-otel-facts/1";

const EVENT_FIELDS: Readonly<Record<string, keyof typeof OTEL_METRIC_CATALOG>> = {
  input_tokens: "telemetry.event.usage.input",
  output_tokens: "telemetry.event.usage.output",
  cache_read_tokens: "telemetry.event.usage.cache_read",
  cache_creation_tokens: "telemetry.event.usage.cache_creation",
  cost_usd: "telemetry.event.cost.estimated",
  cost_usd_micros: "telemetry.event.cost.estimated_micros",
  duration_ms: "telemetry.event.latency.duration",
  ttft_ms: "telemetry.event.latency.time_to_first_token",
};

export function analyzeOtelFacts(
  analysisRunId: string,
  observations: readonly NormalizedObservation[],
): AnalysisRecord[] {
  const records: AnalysisRecord[] = [];
  for (const evidence of observations) {
    if (evidence.stableKey.startsWith("otel-log:")) {
      for (const [field, definitionKey] of Object.entries(EVENT_FIELDS)) {
        const value = evidence.payload[field];
        if (typeof value !== "number") continue;
        const definition = OTEL_METRIC_CATALOG[definitionKey as keyof typeof OTEL_METRIC_CATALOG];
        const key = `${definition.key}.occurrence.${evidence.id}`;
        records.push({
          id: stableId("analysis", { analysisRunId, key }), analysisRunId, key,
          recordType: "METRIC", derivation: "OBSERVED", value, unit: definition.unit,
          availability: "AVAILABLE",
          reason: field.startsWith("cost_")
            ? "Vendor telemetry cost is an estimate and is namespaced separately from billing data."
            : null,
          evidenceIds: [evidence.id], evidenceStatus: "PRESENT",
        });
      }
      if (typeof evidence.payload.model === "string") {
        const definition = OTEL_METRIC_CATALOG["telemetry.event.model.request"];
        const key = `${definition.key}.occurrence.${evidence.id}`;
        records.push({
          id: stableId("analysis", { analysisRunId, key }), analysisRunId, key,
          recordType: "METRIC", derivation: "OBSERVED",
          value: { model: evidence.payload.model, requests: 1 }, unit: "count",
          availability: "AVAILABLE", reason: null,
          evidenceIds: [evidence.id], evidenceStatus: "PRESENT",
        });
      }
    }
    if (evidence.stableKey.startsWith("otel-metric:") &&
      typeof evidence.payload.metricName === "string" && typeof evidence.payload.value === "number") {
      const definitionKey = `telemetry.metric.${evidence.payload.metricName}`;
      const definition = OTEL_METRIC_CATALOG[definitionKey as keyof typeof OTEL_METRIC_CATALOG];
      if (!definition) continue;
      const key = `${definition.key}.occurrence.${evidence.id}`;
      records.push({
        id: stableId("analysis", { analysisRunId, key }), analysisRunId, key,
        recordType: "METRIC", derivation: "OBSERVED",
        value: {
          value: evidence.payload.value,
          ...(typeof evidence.payload.type === "string" ? { type: evidence.payload.type } : {}),
          ...(typeof evidence.payload.model === "string" ? { model: evidence.payload.model } : {}),
        },
        unit: typeof evidence.payload.unit === "string" ? evidence.payload.unit : null,
        availability: "AVAILABLE",
        reason: evidence.payload.metricName === "claude_code.cost.usage"
          ? "Vendor telemetry cost is an estimate and is namespaced separately from billing data."
          : null,
        evidenceIds: [evidence.id], evidenceStatus: "PRESENT",
      });
    }
  }
  return records;
}
