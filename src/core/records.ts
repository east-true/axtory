import type { Availability } from "./model.js";

export type Derivation = "OBSERVED" | "CALCULATED" | "INFERRED" | "ESTIMATED";
export type Provenance =
  | "OFFICIAL_API"
  | "DOCUMENTED_STORAGE"
  | "LOCAL_FILE"
  | "EXTERNAL_API"
  | "USER_PROVIDED"
  | "HEURISTIC";
export type ObservationKind = "EVENT" | "SNAPSHOT" | "CONTENT" | "METRIC" | "RELATION";
export type DataClassification =
  | "PUBLIC_METADATA"
  | "LOCAL_METADATA"
  | "IDENTIFYING_METADATA"
  | "CONVERSATION_CONTENT"
  | "SOURCE_CONTENT"
  | "TOOL_CONTENT"
  | "SECRET"
  | "PERSONAL_DATA";
export type TimeQuality =
  | "EXACT"
  | "SOURCE_REPORTED"
  | "RECEIVER_TIMESTAMP"
  | "FILE_MODIFIED_APPROXIMATION"
  | "ORDER_ONLY"
  | "UNKNOWN";

export type LineageRelationType =
  | "RESUMED_FROM"
  | "FORKED_FROM"
  | "SUBAGENT_OF"
  | "COMPACTED_FROM"
  | "CONTINUED_FROM"
  | "UNKNOWN";

export interface RawObservation {
  id: string;
  sourceRevisionId: string;
  observationType:
    | "FIXTURE_DOCUMENT"
    | "VENDOR_SESSION_VIEW"
    | "CODEX_THREAD_VIEW"
    | "WORK_SYSTEM_VIEW"
    | "GIT_SNAPSHOT"
    | "LIVE_EVENT";
  provenance: Provenance;
  dataClassification: DataClassification;
  payloadReference: string;
  observedAt: string;
  sourceModifiedAt: string | null;
}

export interface NormalizedObservation {
  id: string;
  sourceRevisionId: string;
  stableKey: string;
  kind: ObservationKind;
  derivation: "OBSERVED";
  provenance: Provenance;
  dataClassification: DataClassification;
  occurredAt: string | null;
  timeQuality: TimeQuality;
  payload: Readonly<Record<string, unknown>>;
}

export interface AnalysisRecord {
  id: string;
  analysisRunId: string;
  key: string;
  recordType: "METRIC" | "FINDING" | "ASSERTION" | "RELATION";
  derivation: Derivation;
  value: unknown;
  unit: string | null;
  availability: Availability;
  reason: string | null;
  evidenceIds: readonly string[];
  evidenceStatus: "PRESENT" | "EVIDENCE_REMOVED" | "INVALIDATED";
}

export const VERIFICATION_TYPES = [
  "SOURCE_INTEGRITY",
  "TECHNICAL",
  "HUMAN_ACCEPTANCE",
  "WORKFLOW",
  "DEPLOYMENT",
  "PRODUCTION_OUTCOME",
] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

export const VERIFICATION_STATUSES = [
  "VERIFIED",
  "PARTIAL",
  "FAILED",
  "REJECTED",
  "CONTRADICTED",
  "UNKNOWN",
  "NOT_APPLICABLE",
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface VerificationRecord {
  id: string;
  analysisRecordId: string;
  verificationType: VerificationType;
  status: VerificationStatus;
  provenance: Provenance;
  evidenceIds: readonly string[];
  note: string | null;
  verifiedAt: string;
}

export interface UserAnnotation {
  id: string;
  targetType: "SOURCE_REVISION" | "ANALYSIS_RECORD";
  targetId: string;
  assertion: string;
  createdAt: string;
}
