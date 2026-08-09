import type { DataClassification, Provenance } from "../../core/records.js";

export const ADDITIONAL_AI_PROVIDERS = ["GEMINI_CLI", "OPENCODE", "CURSOR", "AIDER"] as const;
export type AdditionalAiProvider = (typeof ADDITIONAL_AI_PROVIDERS)[number];

export type AdditionalAiCoverage =
  | "COMPLETE_FOR_RETURNED_VIEW"
  | "PARTIAL_LIMIT"
  | "PARTIAL_SOURCE_CHANGED"
  | "METADATA_ONLY"
  | "UNKNOWN";

export interface AdditionalAiSessionSummary {
  provider: AdditionalAiProvider;
  scopeIdentity: string;
  externalId: string;
  createdAt: string | null;
  sourceUpdatedAt: string | null;
}

export interface AdditionalAiMessage {
  externalId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | "TOOL" | "UNKNOWN";
  occurredAt: string | null;
  contentIdentity: string | null;
  partTypes: readonly string[];
}

export interface AdditionalAiSessionView {
  summary: AdditionalAiSessionSummary;
  coverage: AdditionalAiCoverage;
  messages: readonly AdditionalAiMessage[];
  rawPayload: unknown;
  provenance: Provenance;
  dataClassification: DataClassification;
}

export interface AdditionalAiSessionList {
  items: readonly AdditionalAiSessionSummary[];
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_LIMIT" | "METADATA_ONLY";
}

export interface AdditionalAiSourceApi {
  readonly provider: AdditionalAiProvider;
  readonly scopeIdentity: string;
  listSessions(options: { limit: number }): Promise<AdditionalAiSessionList>;
  readSession(summary: AdditionalAiSessionSummary): Promise<AdditionalAiSessionView>;
}

export function isoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function externalIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{4,256}$/u.test(value)) {
    throw new Error(`${label} is missing or invalid`);
  }
  return value;
}
