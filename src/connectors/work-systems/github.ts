import { sha256 } from "../../core/canonical-json.js";
import { array, record, requestJson, validateApiBaseUrl, type WorkFetch } from "./http.js";
import {
  identifier,
  safeState,
  timestamp,
  type WorkArtifact,
  type WorkArtifactKind,
  type WorkCommitLink,
  type WorkStatusCategory,
  type WorkSystemApi,
} from "./types.js";

const GITHUB_KINDS = ["CHANGE_REQUEST", "CI_RUN", "DEPLOYMENT"] as const;

function repositoryPart(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/u.test(value)) throw new Error(`GitHub ${label} is invalid`);
  return value;
}

function pageNumber(cursor?: string | null): number {
  if (cursor === undefined || cursor === null) return 1;
  const value = Number(cursor);
  if (!Number.isInteger(value) || value < 1) throw new Error("GitHub pagination cursor is invalid");
  return value;
}

function nextPage(headers: Headers, current: number): string | null {
  const link = headers.get("link");
  return link?.split(",").some((part) => /rel="next"/u.test(part)) ? String(current + 1) : null;
}

function commitLinks(values: Array<[WorkCommitLink["role"], unknown]>): WorkCommitLink[] {
  const seen = new Set<string>();
  return values.flatMap(([role, value]) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 256 || seen.has(`${role}:${value}`)) return [];
    seen.add(`${role}:${value}`);
    return [{ role, objectId: value }];
  });
}

function prStatus(item: Record<string, unknown>): WorkStatusCategory {
  if (timestamp(item.merged_at)) return "MERGED";
  if (item.state === "open") return "OPEN";
  if (item.state === "closed") return "CLOSED";
  return "UNKNOWN";
}

function runStatus(item: Record<string, unknown>): WorkStatusCategory {
  if (item.status !== "completed") return "IN_PROGRESS";
  if (item.conclusion === "success") return "SUCCEEDED";
  if (["failure", "timed_out", "action_required"].includes(String(item.conclusion))) return "FAILED";
  if (["cancelled", "skipped", "neutral", "stale"].includes(String(item.conclusion))) return "CANCELED";
  return "UNKNOWN";
}

function deploymentStatus(value: unknown): WorkStatusCategory {
  if (value === "success") return "SUCCEEDED";
  if (value === "failure" || value === "error") return "FAILED";
  if (value === "inactive") return "CANCELED";
  if (["queued", "pending", "in_progress"].includes(String(value))) return "IN_PROGRESS";
  return "UNKNOWN";
}

export class GitHubWorkSystemApi implements WorkSystemApi {
  readonly provider = "GITHUB" as const;
  readonly supportedKinds: readonly WorkArtifactKind[] = GITHUB_KINDS;
  readonly scopeIdentity: string;
  private readonly baseUrl: string;
  private readonly repositoryPath: string;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: {
    owner: string;
    repository: string;
    token?: string;
    baseUrl?: string;
    fetcher?: WorkFetch;
  }) {
    this.baseUrl = validateApiBaseUrl(options.baseUrl ?? "https://api.github.com");
    const owner = repositoryPart(options.owner, "owner");
    const repository = repositoryPart(options.repository, "repository");
    this.repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
    this.scopeIdentity = sha256(`github:${this.baseUrl}:${owner.toLowerCase()}/${repository.toLowerCase()}`);
    this.fetcher = options.fetcher ?? fetch;
    this.headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2026-03-10",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    };
  }

  private readonly fetcher: WorkFetch;

  async listArtifacts(kind: WorkArtifactKind, options: { cursor?: string | null; limit: number }) {
    if (!this.supportedKinds.includes(kind)) throw new Error(`GitHub does not support ${kind}`);
    const page = pageNumber(options.cursor);
    if (kind === "CHANGE_REQUEST") return this.pullRequests(page, options.limit);
    if (kind === "CI_RUN") return this.workflowRuns(page, options.limit);
    return this.deployments(page, options.limit);
  }

  private async pullRequests(page: number, limit: number) {
    const url = new URL(`${this.baseUrl}${this.repositoryPath}/pulls`);
    Object.entries({ state: "all", sort: "updated", direction: "desc", per_page: String(limit), page: String(page) })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await requestJson(this.fetcher, url.toString(), { headers: this.headers });
    const items = array(response.value, "GitHub pull requests").map((value): WorkArtifact => {
      const item = record(value, "GitHub pull request");
      const head = item.head && typeof item.head === "object" ? record(item.head, "GitHub pull request head") : {};
      const state = safeState(item.state);
      const createdAt = timestamp(item.created_at);
      const updatedAt = timestamp(item.updated_at);
      const mergedAt = timestamp(item.merged_at);
      const links = commitLinks([["HEAD", head.sha], ["MERGE", item.merge_commit_sha]]);
      const externalId = identifier(item.id ?? item.number, "pull request id");
      const statusCategory = prStatus(item);
      return {
        provider: this.provider, scopeIdentity: this.scopeIdentity, kind: "CHANGE_REQUEST", externalId,
        sourceUpdatedAt: updatedAt, createdAt, completedAt: mergedAt ?? timestamp(item.closed_at),
        sourceState: state, statusCategory, commitLinks: links,
        sourceView: {
          schemaVersion: "axtory.github.pull.v1", id: externalId,
          number: typeof item.number === "number" ? item.number : null, state,
          draft: item.draft === true, createdAt, updatedAt, mergedAt,
          closedAt: timestamp(item.closed_at), statusCategory,
          commitLinks: links,
        },
      };
    });
    return { items, nextCursor: nextPage(response.headers, page) };
  }

  private async workflowRuns(page: number, limit: number) {
    const url = new URL(`${this.baseUrl}${this.repositoryPath}/actions/runs`);
    url.searchParams.set("per_page", String(limit));
    url.searchParams.set("page", String(page));
    const response = await requestJson(this.fetcher, url.toString(), { headers: this.headers });
    const root = record(response.value, "GitHub workflow runs");
    const items = array(root.workflow_runs, "GitHub workflow runs").map((value): WorkArtifact => {
      const item = record(value, "GitHub workflow run");
      const externalId = identifier(item.id, "workflow run id");
      const statusCategory = runStatus(item);
      const sourceState = safeState(item.conclusion ?? item.status);
      const links = commitLinks([["SUBJECT", item.head_sha]]);
      const createdAt = timestamp(item.created_at);
      const updatedAt = timestamp(item.updated_at);
      return {
        provider: this.provider, scopeIdentity: this.scopeIdentity, kind: "CI_RUN", externalId,
        sourceUpdatedAt: updatedAt, createdAt,
        completedAt: item.status === "completed" ? updatedAt : null,
        sourceState, statusCategory, commitLinks: links,
        sourceView: {
          schemaVersion: "axtory.github.workflow-run.v1", id: externalId,
          status: safeState(item.status), conclusion: safeState(item.conclusion),
          event: safeState(item.event), createdAt, updatedAt, statusCategory, commitLinks: links,
        },
      };
    });
    return { items, nextCursor: nextPage(response.headers, page) };
  }

  private async deployments(page: number, limit: number) {
    const url = new URL(`${this.baseUrl}${this.repositoryPath}/deployments`);
    url.searchParams.set("per_page", String(limit));
    url.searchParams.set("page", String(page));
    const response = await requestJson(this.fetcher, url.toString(), { headers: this.headers });
    const items: WorkArtifact[] = [];
    for (const value of array(response.value, "GitHub deployments")) {
      const item = record(value, "GitHub deployment");
      const externalId = identifier(item.id, "deployment id");
      const statusesUrl = new URL(`${this.baseUrl}${this.repositoryPath}/deployments/${encodeURIComponent(externalId)}/statuses`);
      statusesUrl.searchParams.set("per_page", "1");
      const statuses = await requestJson(this.fetcher, statusesUrl.toString(), { headers: this.headers });
      const latestValue = array(statuses.value, "GitHub deployment statuses")[0];
      const latest = latestValue === undefined ? {} : record(latestValue, "GitHub deployment status");
      const sourceState = safeState(latest.state ?? "created");
      const statusCategory = deploymentStatus(latest.state);
      const createdAt = timestamp(item.created_at);
      const updatedAt = timestamp(latest.updated_at) ?? timestamp(item.updated_at);
      const links = commitLinks([["SUBJECT", item.sha]]);
      const environmentIdentity = typeof item.environment === "string" ? sha256(item.environment) : null;
      items.push({
        provider: this.provider, scopeIdentity: this.scopeIdentity, kind: "DEPLOYMENT", externalId,
        sourceUpdatedAt: updatedAt, createdAt,
        completedAt: ["SUCCEEDED", "FAILED", "CANCELED"].includes(statusCategory) ? updatedAt : null,
        sourceState, statusCategory, commitLinks: links,
        sourceView: {
          schemaVersion: "axtory.github.deployment.v1", id: externalId, sourceState,
          statusCategory, createdAt, updatedAt, environmentIdentity, commitLinks: links,
        },
      });
    }
    return { items, nextCursor: nextPage(response.headers, page) };
  }
}
