export const AVAILABILITY = [
  "AVAILABLE",
  "PARTIAL",
  "NOT_COLLECTED",
  "NOT_CONFIGURED",
  "NOT_SUPPORTED",
  "NOT_RETAINED",
  "REDACTED",
  "PERMISSION_DENIED",
  "COLLECTION_ERROR",
  "SOURCE_UNAVAILABLE",
  "UNKNOWN",
] as const;

export type Availability = (typeof AVAILABILITY)[number];

export type AvailableValue<T> =
  | { status: "AVAILABLE"; value: T }
  | { status: Exclude<Availability, "AVAILABLE">; reason: string };

export const available = <T>(value: T): AvailableValue<T> => ({
  status: "AVAILABLE",
  value,
});

export const unavailable = <T>(
  status: Exclude<Availability, "AVAILABLE">,
  reason: string,
): AvailableValue<T> => {
  if (reason.trim().length === 0) {
    throw new Error("an unavailable value requires a reason");
  }
  return { status, reason };
};

export type ExecutionEnvironmentType =
  | "WINDOWS"
  | "WSL"
  | "LINUX"
  | "MACOS"
  | "DOCKER"
  | "DEV_CONTAINER"
  | "REMOTE_HOST"
  | "UNKNOWN";

export interface ExecutionEnvironment {
  id: string;
  type: ExecutionEnvironmentType;
  os: string;
  architecture: string;
  homeDirectory: AvailableValue<string>;
}

export interface SourceProfile {
  id: string;
  sourceType: "CLAUDE_CODE" | "CODEX" | "LOCAL_GIT" | "FIXTURE";
  environmentId: string;
  dataRoot: AvailableValue<string>;
  executablePath: AvailableValue<string>;
  activeVersion: AvailableValue<string>;
}

export interface Capability {
  key: string;
  availability: Availability;
  reason?: string;
  evidence: readonly string[];
}

export interface CapabilityAssessment {
  sourceProfileId: string;
  assessedAt: string;
  capabilities: readonly Capability[];
}
