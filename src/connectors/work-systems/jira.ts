import { sha256 } from "../../core/canonical-json.js";
import { array, record, requestJson, validateApiBaseUrl, type WorkFetch } from "./http.js";
import {
  identifier, safeState, timestamp, type WorkArtifact, type WorkArtifactKind,
  type WorkStatusCategory, type WorkSystemApi,
} from "./types.js";

function statusCategory(value: unknown): WorkStatusCategory {
  if (value === "done") return "COMPLETED";
  if (value === "indeterminate") return "IN_PROGRESS";
  if (value === "new") return "BACKLOG";
  return "UNKNOWN";
}

export class JiraWorkSystemApi implements WorkSystemApi {
  readonly provider = "JIRA" as const;
  readonly supportedKinds: readonly WorkArtifactKind[] = ["WORK_ITEM"];
  readonly scopeIdentity: string;
  private readonly baseUrl: string;
  private readonly projectKey: string;
  private readonly fetcher: WorkFetch;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: {
    baseUrl: string;
    projectKey: string;
    email?: string;
    apiToken?: string;
    fetcher?: WorkFetch;
  }) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(options.projectKey)) throw new Error("Jira project key is invalid");
    if ((options.email === undefined) !== (options.apiToken === undefined)) {
      throw new Error("Jira email and API token must be configured together");
    }
    this.baseUrl = validateApiBaseUrl(options.baseUrl);
    this.projectKey = options.projectKey;
    this.scopeIdentity = sha256(`jira:${this.baseUrl}:${this.projectKey.toUpperCase()}`);
    this.fetcher = options.fetcher ?? fetch;
    this.headers = options.email && options.apiToken
      ? { Authorization: `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString("base64")}` }
      : {};
  }

  async listArtifacts(kind: WorkArtifactKind, options: { cursor?: string | null; limit: number }) {
    if (kind !== "WORK_ITEM") throw new Error(`Jira does not support ${kind}`);
    const response = await requestJson(this.fetcher, `${this.baseUrl}/rest/api/3/search/jql`, {
      method: "POST",
      headers: this.headers,
      body: {
        jql: `project = "${this.projectKey}" ORDER BY updated DESC`,
        fields: ["status", "created", "updated", "resolutiondate"],
        maxResults: options.limit,
        ...(options.cursor ? { nextPageToken: options.cursor } : {}),
      },
    });
    const root = record(response.value, "Jira issue search");
    const items = array(root.issues, "Jira issues").map((value): WorkArtifact => {
      const item = record(value, "Jira issue");
      const fields = record(item.fields, "Jira issue fields");
      const status = fields.status && typeof fields.status === "object" ? record(fields.status, "Jira status") : {};
      const category = status.statusCategory && typeof status.statusCategory === "object"
        ? record(status.statusCategory, "Jira status category")
        : {};
      const sourceState = safeState(category.key ?? status.name);
      const canonicalStatus = statusCategory(category.key);
      const externalId = identifier(item.id ?? item.key, "issue id");
      const createdAt = timestamp(fields.created);
      const updatedAt = timestamp(fields.updated);
      const completedAt = timestamp(fields.resolutiondate);
      return {
        provider: this.provider, scopeIdentity: this.scopeIdentity, kind: "WORK_ITEM", externalId,
        sourceUpdatedAt: updatedAt, createdAt, completedAt, sourceState,
        statusCategory: canonicalStatus, commitLinks: [],
        sourceView: {
          schemaVersion: "axtory.jira.issue.v1", id: externalId,
          keyIdentity: typeof item.key === "string" ? sha256(item.key) : null,
          sourceState, statusCategory: canonicalStatus, createdAt, updatedAt, completedAt,
        },
      };
    });
    const nextCursor = typeof root.nextPageToken === "string" && root.nextPageToken
      ? root.nextPageToken
      : null;
    return { items, nextCursor };
  }
}
