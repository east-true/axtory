export const WORK_PROVIDERS = ["GITHUB", "GITLAB", "JIRA", "LINEAR"] as const;
export type WorkProvider = (typeof WORK_PROVIDERS)[number];

export const WORK_ARTIFACT_KINDS = ["CHANGE_REQUEST", "CI_RUN", "DEPLOYMENT", "WORK_ITEM"] as const;
export type WorkArtifactKind = (typeof WORK_ARTIFACT_KINDS)[number];

export type WorkStatusCategory =
  | "OPEN"
  | "MERGED"
  | "CLOSED"
  | "IN_PROGRESS"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "COMPLETED"
  | "BACKLOG"
  | "UNKNOWN";

export type CommitLinkRole = "HEAD" | "MERGE" | "SUBJECT";

export interface WorkCommitLink {
  role: CommitLinkRole;
  objectId: string;
}

export interface WorkArtifact {
  provider: WorkProvider;
  scopeIdentity: string;
  kind: WorkArtifactKind;
  externalId: string;
  sourceUpdatedAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  sourceState: string;
  statusCategory: WorkStatusCategory;
  commitLinks: readonly WorkCommitLink[];
  /** Allowlisted metadata view. Vendor content and identities must not be copied here. */
  sourceView: Readonly<Record<string, unknown>>;
}

export interface WorkArtifactPage {
  items: readonly WorkArtifact[];
  nextCursor: string | null;
}

export interface WorkSystemApi {
  readonly provider: WorkProvider;
  readonly scopeIdentity: string;
  readonly supportedKinds: readonly WorkArtifactKind[];
  listArtifacts(kind: WorkArtifactKind, options: {
    cursor?: string | null;
    limit: number;
  }): Promise<WorkArtifactPage>;
}

export interface WorkSystemDiscovery {
  provider: WorkProvider;
  scopeIdentity: string;
  authentication: "AVAILABLE" | "NOT_CONFIGURED";
  capabilities: Readonly<Record<WorkArtifactKind, "AVAILABLE" | "NOT_SUPPORTED">>;
  assessedAt: string;
}

export function discoverWorkSystem(input: {
  provider: WorkProvider;
  scopeIdentity: string;
  hasCredential: boolean;
  supportedKinds: readonly WorkArtifactKind[];
  now?: () => Date;
}): WorkSystemDiscovery {
  if (!/^[a-f0-9]{64}$/u.test(input.scopeIdentity)) throw new Error("work-system scope identity must be SHA-256");
  return {
    provider: input.provider,
    scopeIdentity: input.scopeIdentity,
    authentication: input.hasCredential ? "AVAILABLE" : "NOT_CONFIGURED",
    capabilities: Object.fromEntries(WORK_ARTIFACT_KINDS.map((kind) => [
      kind, input.supportedKinds.includes(kind) ? "AVAILABLE" : "NOT_SUPPORTED",
    ])) as Record<WorkArtifactKind, "AVAILABLE" | "NOT_SUPPORTED">,
    assessedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

export function safeState(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_. -]{0,63}$/u.test(value)
    ? value
    : "unknown";
}

export function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function identifier(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).length === 0 ||
      String(value).length > 256) {
    throw new Error(`work-system ${label} is missing or invalid`);
  }
  return String(value);
}
