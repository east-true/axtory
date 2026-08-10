/**
 * Canonical time handling.
 *
 * Every `occurredAt` that reaches storage must be a UTC ISO-8601 instant. Analysis compares those
 * values as strings and buckets them by UTC day, so a retained Vendor offset such as `+09:00`
 * would place an observation in the wrong window and the wrong calendar day.
 */

/** Normalize a source-reported timestamp string to a UTC ISO-8601 instant, or null when absent. */
export function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/** Normalize an epoch value to a UTC ISO-8601 instant, or null when it is not a finite instant. */
export function isoFromEpoch(value: unknown, unit: "MILLISECONDS" | "SECONDS"): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(unit === "SECONDS" ? value * 1_000 : value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
