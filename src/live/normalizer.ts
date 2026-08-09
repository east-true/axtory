import { sha256, stableId } from "../core/canonical-json.js";
import type { NormalizedObservation } from "../core/records.js";
import type { SpoolEnvelope } from "./spool.js";

export const LIVE_NORMALIZER_VERSION = "claude-live/1";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function safeLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value) ? value : null;
}

function finiteNonnegative(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+(?:\.\d+)?$/u.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function anyValue(value: unknown): unknown {
  const item = record(value);
  if (!item) return null;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"] as const) {
    if (key in item) return item[key];
  }
  return null;
}

function attributes(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const entry of value.slice(0, 256)) {
    const item = record(entry);
    if (typeof item?.key !== "string") continue;
    output[item.key] = anyValue(item.value);
  }
  return output;
}

function unixNanoToIso(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return null;
  try {
    return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
  } catch {
    return null;
  }
}

function observation(
  envelope: SpoolEnvelope,
  revisionId: string,
  stableKey: string,
  payload: Record<string, unknown>,
  occurredAt: string | null,
  timeQuality: "SOURCE_REPORTED" | "RECEIVER_TIMESTAMP" = occurredAt ? "SOURCE_REPORTED" : "RECEIVER_TIMESTAMP",
): NormalizedObservation {
  return {
    id: stableId("obs", { revisionId, stableKey }), sourceRevisionId: revisionId, stableKey,
    kind: "EVENT", derivation: "OBSERVED", provenance: "OFFICIAL_API",
    dataClassification: "LOCAL_METADATA", occurredAt,
    timeQuality, payload,
  };
}

function normalizeHook(envelope: SpoolEnvelope, revisionId: string): NormalizedObservation[] {
  const payload = record(envelope.payload);
  if (!payload) throw new Error("Claude Hook payload must be an object");
  const eventName = safeLabel(payload.hook_event_name) ?? safeLabel(payload.event_name) ?? "UNKNOWN";
  return [observation(envelope, revisionId, "hook-event", {
    eventName,
    sessionIdentity: typeof payload.session_id === "string" ? sha256(payload.session_id) : null,
    toolName: safeLabel(payload.tool_name),
    toolUseIdentity: typeof payload.tool_use_id === "string" ? sha256(payload.tool_use_id) : null,
  }, envelope.receivedAt, "RECEIVER_TIMESTAMP")];
}

function normalizeLogs(envelope: SpoolEnvelope, revisionId: string): NormalizedObservation[] {
  const root = record(envelope.payload);
  const resourceLogs = Array.isArray(root?.resourceLogs) ? root.resourceLogs : [];
  const output: NormalizedObservation[] = [];
  for (const resource of resourceLogs.slice(0, 128)) {
    const scopeLogs = Array.isArray(record(resource)?.scopeLogs) ? record(resource)!.scopeLogs as unknown[] : [];
    for (const scope of scopeLogs.slice(0, 128)) {
      const logs = Array.isArray(record(scope)?.logRecords) ? record(scope)!.logRecords as unknown[] : [];
      for (const log of logs.slice(0, 10_000 - output.length)) {
        const item = record(log);
        const attrs = attributes(item?.attributes);
        const eventName = safeLabel(attrs["event.name"]) ?? safeLabel(anyValue(item?.body)) ?? "UNKNOWN";
        const eventTimestamp = typeof attrs["event.timestamp"] === "string" &&
          Number.isFinite(Date.parse(attrs["event.timestamp"]))
          ? new Date(Date.parse(attrs["event.timestamp"])).toISOString()
          : unixNanoToIso(item?.timeUnixNano);
        const safe: Record<string, unknown> = { eventName };
        for (const key of [
          "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens",
          "cost_usd", "cost_usd_micros", "duration_ms", "ttft_ms", "result_tokens",
          "pre_tokens", "post_tokens", "total_duration_ms",
        ]) {
          const value = finiteNonnegative(attrs[key]);
          if (value !== null) safe[key] = value;
        }
        for (const key of ["model", "tool_name", "type", "success", "decision", "trigger"]) {
          const value = safeLabel(attrs[key]);
          if (value !== null) safe[key] = value;
        }
        output.push(observation(envelope, revisionId, `otel-log:${output.length}`, safe, eventTimestamp));
      }
    }
  }
  return output;
}

function normalizeMetrics(envelope: SpoolEnvelope, revisionId: string): NormalizedObservation[] {
  const root = record(envelope.payload);
  const resourceMetrics = Array.isArray(root?.resourceMetrics) ? root.resourceMetrics : [];
  const output: NormalizedObservation[] = [];
  for (const resource of resourceMetrics.slice(0, 128)) {
    const scopeMetrics = Array.isArray(record(resource)?.scopeMetrics) ? record(resource)!.scopeMetrics as unknown[] : [];
    for (const scope of scopeMetrics.slice(0, 128)) {
      const metrics = Array.isArray(record(scope)?.metrics) ? record(scope)!.metrics as unknown[] : [];
      for (const metricValue of metrics.slice(0, 10_000 - output.length)) {
        const metric = record(metricValue);
        const metricName = safeLabel(metric?.name);
        if (!metricName?.startsWith("claude_code.")) continue;
        const data = record(metric?.sum) ?? record(metric?.gauge) ?? record(metric?.histogram);
        const points = Array.isArray(data?.dataPoints) ? data.dataPoints : [];
        for (const pointValue of points.slice(0, 10_000 - output.length)) {
          const point = record(pointValue);
          const attrs = attributes(point?.attributes);
          const value = finiteNonnegative(point?.asInt) ?? finiteNonnegative(point?.asDouble) ??
            finiteNonnegative(point?.sum);
          if (value === null) continue;
          const safe: Record<string, unknown> = { metricName, value, unit: safeLabel(metric?.unit) };
          for (const key of ["type", "model"]) {
            const label = safeLabel(attrs[key]);
            if (label !== null) safe[key] = label;
          }
          output.push(observation(envelope, revisionId, `otel-metric:${output.length}`, safe,
            unixNanoToIso(point?.timeUnixNano)));
        }
      }
    }
  }
  return output;
}

export function normalizeLiveEnvelope(envelope: SpoolEnvelope, revisionId: string): NormalizedObservation[] {
  if (envelope.channel === "CLAUDE_HOOK") return normalizeHook(envelope, revisionId);
  if (envelope.channel === "CLAUDE_OTEL_LOGS") return normalizeLogs(envelope, revisionId);
  return normalizeMetrics(envelope, revisionId);
}
