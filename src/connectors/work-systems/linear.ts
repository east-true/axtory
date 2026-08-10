import { sha256 } from "../../core/canonical-json.js";
import { array, record, requestJson, validateApiBaseUrl, type WorkFetch } from "./http.js";
import {
  identifier, safeState, timestamp, type WorkArtifact, type WorkArtifactKind,
  type WorkStatusCategory, type WorkSystemApi,
} from "./types.js";

const ISSUES_QUERY = `query AxtoryIssues($first: Int!, $after: String, $teamId: ID!) {
  issues(first: $first, after: $after, filter: { team: { id: { eq: $teamId } } }, orderBy: updatedAt) {
    nodes { id identifier createdAt updatedAt completedAt canceledAt state { type } }
    pageInfo { hasNextPage endCursor }
  }
}`;

function statusCategory(value: unknown, completedAt: string | null, canceledAt: string | null): WorkStatusCategory {
  if (canceledAt) return "CANCELED";
  if (completedAt || value === "completed") return "COMPLETED";
  if (value === "started") return "IN_PROGRESS";
  if (value === "backlog" || value === "unstarted" || value === "triage") return "BACKLOG";
  if (value === "canceled") return "CANCELED";
  return "UNKNOWN";
}

export class LinearWorkSystemApi implements WorkSystemApi {
  readonly provider = "LINEAR" as const;
  readonly supportedKinds: readonly WorkArtifactKind[] = ["WORK_ITEM"];
  readonly scopeIdentity: string;
  private readonly baseUrl: string;
  private readonly teamId: string;
  private readonly token: string;
  private readonly fetcher: WorkFetch;

  constructor(options: { teamId: string; token: string; baseUrl?: string; fetcher?: WorkFetch }) {
    if (!options.teamId || options.teamId.length > 128 || /[\u0000-\u001f]/u.test(options.teamId)) {
      throw new Error("Linear team ID is invalid");
    }
    if (!options.token) throw new Error("Linear API token is required");
    this.baseUrl = validateApiBaseUrl(options.baseUrl ?? "https://api.linear.app/graphql");
    this.teamId = options.teamId;
    this.token = options.token;
    this.scopeIdentity = sha256(`linear:${this.baseUrl}:${this.teamId}`);
    this.fetcher = options.fetcher ?? fetch;
  }

  async listArtifacts(kind: WorkArtifactKind, options: { cursor?: string | null; limit: number }) {
    if (kind !== "WORK_ITEM") throw new Error(`Linear does not support ${kind}`);
    const response = await requestJson(this.fetcher, this.baseUrl, {
      method: "POST",
      headers: { Authorization: this.token },
      body: {
        query: ISSUES_QUERY,
        variables: { first: options.limit, after: options.cursor ?? null, teamId: this.teamId },
      },
    });
    const root = record(response.value, "Linear GraphQL response");
    if (Array.isArray(root.errors) && root.errors.length > 0) {
      throw new Error("Linear GraphQL returned one or more errors");
    }
    const data = record(root.data, "Linear GraphQL data");
    const issues = record(data.issues, "Linear issues");
    const items = array(issues.nodes, "Linear issue nodes").map((value): WorkArtifact => {
      const item = record(value, "Linear issue");
      const state = item.state && typeof item.state === "object" ? record(item.state, "Linear issue state") : {};
      const sourceState = safeState(state.type);
      const createdAt = timestamp(item.createdAt);
      const updatedAt = timestamp(item.updatedAt);
      const completedAt = timestamp(item.completedAt);
      const canceledAt = timestamp(item.canceledAt);
      const canonicalStatus = statusCategory(state.type, completedAt, canceledAt);
      const externalId = identifier(item.id, "issue id");
      return {
        provider: this.provider, scopeIdentity: this.scopeIdentity, kind: "WORK_ITEM", externalId,
        sourceUpdatedAt: updatedAt, createdAt, completedAt: completedAt ?? canceledAt,
        sourceState, statusCategory: canonicalStatus, commitLinks: [],
        sourceView: {
          schemaVersion: "axtory.linear.issue.v1", id: externalId,
          identifierIdentity: typeof item.identifier === "string" ? sha256(item.identifier) : null,
          sourceState, statusCategory: canonicalStatus, createdAt, updatedAt,
          completedAt, canceledAt,
        },
      };
    });
    const pageInfo = record(issues.pageInfo, "Linear page info");
    if (pageInfo.hasNextPage === true && typeof pageInfo.endCursor !== "string") {
      throw new Error("Linear pagination omitted its next cursor");
    }
    return { items, nextCursor: pageInfo.hasNextPage === true ? pageInfo.endCursor as string : null };
  }
}
