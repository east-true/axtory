import { sha256 } from "../../core/canonical-json.js";
import { array, record, requestJson, validateApiBaseUrl, type WorkFetch } from "./http.js";
import {
  identifier, safeState, timestamp, type WorkArtifact, type WorkArtifactKind,
  type WorkCommitLink, type WorkStatusCategory, type WorkSystemApi,
} from "./types.js";

const GITLAB_KINDS = ["CHANGE_REQUEST", "CI_RUN", "DEPLOYMENT"] as const;

function cursorPage(cursor?: string | null): number {
  if (!cursor) return 1;
  const page = Number(cursor);
  if (!Number.isInteger(page) || page < 1) throw new Error("GitLab pagination cursor is invalid");
  return page;
}

function nextPage(headers: Headers, page: number, returned: number, limit: number): string | null {
  const explicit = headers.get("x-next-page");
  if (explicit) return explicit;
  return returned === limit ? String(page + 1) : null;
}

function links(values: Array<[WorkCommitLink["role"], unknown]>): WorkCommitLink[] {
  const seen = new Set<string>();
  return values.flatMap(([role, value]) => {
    if (typeof value !== "string" || !value || value.length > 256 || seen.has(`${role}:${value}`)) return [];
    seen.add(`${role}:${value}`);
    return [{ role, objectId: value }];
  });
}

function changeStatus(item: Record<string, unknown>): WorkStatusCategory {
  if (item.state === "merged") return "MERGED";
  if (item.state === "opened") return "OPEN";
  if (item.state === "closed" || item.state === "locked") return "CLOSED";
  return "UNKNOWN";
}

function executionStatus(value: unknown): WorkStatusCategory {
  if (value === "success") return "SUCCEEDED";
  if (["failed", "failure"].includes(String(value))) return "FAILED";
  if (["canceled", "cancelled", "skipped", "manual"].includes(String(value))) return "CANCELED";
  if (["created", "waiting_for_resource", "preparing", "pending", "running", "scheduled", "blocked"]
    .includes(String(value))) return "IN_PROGRESS";
  return "UNKNOWN";
}

export class GitLabWorkSystemApi implements WorkSystemApi {
  readonly provider = "GITLAB" as const;
  readonly supportedKinds: readonly WorkArtifactKind[] = GITLAB_KINDS;
  readonly scopeIdentity: string;
  private readonly baseUrl: string;
  private readonly project: string;
  private readonly fetcher: WorkFetch;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: { project: string; token?: string; baseUrl?: string; fetcher?: WorkFetch }) {
    if (!options.project || options.project.length > 256 || /[\u0000-\u001f]/u.test(options.project)) {
      throw new Error("GitLab project is invalid");
    }
    this.baseUrl = validateApiBaseUrl(options.baseUrl ?? "https://gitlab.com/api/v4");
    this.project = encodeURIComponent(options.project);
    this.scopeIdentity = sha256(`gitlab:${this.baseUrl}:${options.project}`);
    this.fetcher = options.fetcher ?? fetch;
    this.headers = options.token ? { "PRIVATE-TOKEN": options.token } : {};
  }

  async listArtifacts(kind: WorkArtifactKind, options: { cursor?: string | null; limit: number }) {
    if (!this.supportedKinds.includes(kind)) throw new Error(`GitLab does not support ${kind}`);
    const page = cursorPage(options.cursor);
    const endpoint = kind === "CHANGE_REQUEST" ? "merge_requests" : kind === "CI_RUN" ? "pipelines" : "deployments";
    const url = new URL(`${this.baseUrl}/projects/${this.project}/${endpoint}`);
    url.searchParams.set("per_page", String(options.limit));
    url.searchParams.set("page", String(page));
    if (kind === "CHANGE_REQUEST") {
      url.searchParams.set("scope", "all");
      url.searchParams.set("state", "all");
      url.searchParams.set("order_by", "updated_at");
      url.searchParams.set("sort", "desc");
    } else {
      url.searchParams.set("order_by", "updated_at");
      url.searchParams.set("sort", "desc");
    }
    const response = await requestJson(this.fetcher, url.toString(), { headers: this.headers });
    const values = array(response.value, `GitLab ${endpoint}`);
    const items = values.map((value) => this.artifact(kind, record(value, `GitLab ${endpoint} item`)));
    return { items, nextCursor: nextPage(response.headers, page, values.length, options.limit) };
  }

  private artifact(kind: WorkArtifactKind, item: Record<string, unknown>): WorkArtifact {
    const externalId = identifier(item.id, `${kind} id`);
    const createdAt = timestamp(item.created_at);
    const updatedAt = timestamp(item.updated_at);
    if (kind === "CHANGE_REQUEST") {
      const statusCategory = changeStatus(item);
      const commitLinks = links([["HEAD", item.sha], ["MERGE", item.merge_commit_sha], ["MERGE", item.squash_commit_sha]]);
      return {
        provider: this.provider, scopeIdentity: this.scopeIdentity, kind, externalId,
        sourceUpdatedAt: updatedAt, createdAt,
        completedAt: timestamp(item.merged_at) ?? timestamp(item.closed_at),
        sourceState: safeState(item.state), statusCategory, commitLinks,
        sourceView: {
          schemaVersion: "axtory.gitlab.merge-request.v1", id: externalId,
          iid: typeof item.iid === "number" ? item.iid : null, state: safeState(item.state),
          draft: item.draft === true, createdAt, updatedAt, mergedAt: timestamp(item.merged_at),
          closedAt: timestamp(item.closed_at), statusCategory, commitLinks,
        },
      };
    }
    const sourceState = safeState(item.status);
    const statusCategory = executionStatus(item.status);
    const deployable = item.deployable && typeof item.deployable === "object"
      ? record(item.deployable, "GitLab deployable")
      : {};
    const nestedCommit = deployable.commit && typeof deployable.commit === "object"
      ? record(deployable.commit, "GitLab deployable commit").id
      : undefined;
    const nestedPipeline = deployable.pipeline && typeof deployable.pipeline === "object"
      ? record(deployable.pipeline, "GitLab deployable pipeline").sha
      : undefined;
    const commit = item.sha ?? deployable.commit_sha ?? nestedCommit ?? nestedPipeline;
    const commitLinks = links([["SUBJECT", commit]]);
    const completedAt = timestamp(item.finished_at) ??
      (["SUCCEEDED", "FAILED", "CANCELED"].includes(statusCategory) ? updatedAt : null);
    const environment = item.environment && typeof item.environment === "object"
      ? record(item.environment, "GitLab environment").id ?? record(item.environment, "GitLab environment").name
      : null;
    return {
      provider: this.provider, scopeIdentity: this.scopeIdentity, kind, externalId,
      sourceUpdatedAt: updatedAt, createdAt, completedAt, sourceState, statusCategory, commitLinks,
      sourceView: {
        schemaVersion: kind === "CI_RUN" ? "axtory.gitlab.pipeline.v1" : "axtory.gitlab.deployment.v1",
        id: externalId, sourceState, statusCategory, createdAt, updatedAt, completedAt,
        ...(kind === "DEPLOYMENT" ? { environmentIdentity: environment === null ? null : sha256(String(environment)) } : {}),
        commitLinks,
      },
    };
  }
}
