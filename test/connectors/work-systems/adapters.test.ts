import test from "node:test";
import assert from "node:assert/strict";

import { GitHubWorkSystemApi } from "../../../src/connectors/work-systems/github.js";
import { GitLabWorkSystemApi } from "../../../src/connectors/work-systems/gitlab.js";
import { JiraWorkSystemApi } from "../../../src/connectors/work-systems/jira.js";
import { LinearWorkSystemApi } from "../../../src/connectors/work-systems/linear.js";
import type { WorkFetch } from "../../../src/connectors/work-systems/http.js";

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

test("GitHub adapter allowlists PR, workflow, and deployment metadata", async () => {
  const secret = "PRIVATE-GITHUB-CONTENT";
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetcher: WorkFetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.includes("/pulls")) return json([{
      id: 1, number: 7, state: "closed", draft: false,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
      merged_at: "2026-01-02T00:00:00Z", closed_at: "2026-01-02T00:00:00Z",
      head: { sha: "head-sha", label: secret }, merge_commit_sha: "merge-sha",
      title: secret, body: secret, user: { login: secret }, html_url: `https://example/${secret}`,
    }]);
    if (url.includes("/actions/runs")) return json({ workflow_runs: [{
      id: 2, status: "completed", conclusion: "success", event: "push", head_sha: "ci-sha",
      created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:01:00Z", name: secret,
    }] });
    if (url.includes("/deployments/3/statuses")) return json([{
      state: "success", created_at: "2026-01-03T00:01:00Z", updated_at: "2026-01-03T00:02:00Z",
      description: secret, log_url: `https://example/${secret}`,
    }]);
    if (url.includes("/deployments")) return json([{
      id: 3, sha: "deploy-sha", environment: secret,
      created_at: "2026-01-03T00:00:00Z", updated_at: "2026-01-03T00:00:30Z", payload: secret,
    }]);
    throw new Error(`unexpected URL ${url}`);
  };
  const api = new GitHubWorkSystemApi({ owner: "example", repository: "repo", token: "TOKEN", fetcher });
  const pulls = await api.listArtifacts("CHANGE_REQUEST", { limit: 10 });
  const runs = await api.listArtifacts("CI_RUN", { limit: 10 });
  const deployments = await api.listArtifacts("DEPLOYMENT", { limit: 10 });
  const encoded = JSON.stringify([pulls, runs, deployments]);
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes("TOKEN"), false);
  assert.equal(pulls.items[0]?.statusCategory, "MERGED");
  assert.deepEqual(pulls.items[0]?.commitLinks.map((item) => item.role), ["HEAD", "MERGE"]);
  assert.equal(runs.items[0]?.statusCategory, "SUCCEEDED");
  assert.equal(deployments.items[0]?.statusCategory, "SUCCEEDED");
  assert.equal(requests.every((request) => request.authorization === "Bearer TOKEN"), true);
  assert.equal(requests.some((request) => request.url.includes("/deployments/3/statuses?per_page=1")), true);
});

test("GitLab adapter reads merge requests, pipelines, and deployments with page bounds", async () => {
  const secret = "PRIVATE-GITLAB-CONTENT";
  const urls: string[] = [];
  const fetcher: WorkFetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("merge_requests")) return json([{
      id: 1, iid: 2, state: "merged", draft: false, sha: "head", merge_commit_sha: "merge",
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
      merged_at: "2026-01-02T00:00:00Z", title: secret, description: secret,
    }]);
    if (url.includes("pipelines")) return json([{
      id: 3, status: "failed", sha: "ci", created_at: "2026-01-02T00:00:00Z",
      updated_at: "2026-01-02T00:01:00Z", name: secret, user: { name: secret },
    }]);
    return json([{
      id: 4, status: "success", created_at: "2026-01-03T00:00:00Z",
      updated_at: "2026-01-03T00:01:00Z", finished_at: "2026-01-03T00:01:00Z",
      deployable: { commit: { id: "deploy", title: secret } }, environment: { id: 9, name: secret },
    }]);
  };
  const api = new GitLabWorkSystemApi({ project: "group/repo", token: "TOKEN", fetcher });
  const values = [
    await api.listArtifacts("CHANGE_REQUEST", { limit: 10 }),
    await api.listArtifacts("CI_RUN", { limit: 10 }),
    await api.listArtifacts("DEPLOYMENT", { limit: 10 }),
  ];
  assert.equal(JSON.stringify(values).includes(secret), false);
  assert.deepEqual(values.map((page) => page.items[0]?.statusCategory), ["MERGED", "FAILED", "SUCCEEDED"]);
  assert.deepEqual(values[2]?.items[0]?.commitLinks, [{ role: "SUBJECT", objectId: "deploy" }]);
  assert.equal(urls.every((url) => url.includes("per_page=10") && url.includes("page=1")), true);
  assert.equal(urls[0]?.includes("projects/group%2Frepo/merge_requests"), true);
});

test("Jira enhanced search requests only status and time fields", async () => {
  const secret = "PRIVATE-JIRA-CONTENT";
  let body: Record<string, unknown> = {};
  let authorization: string | null = null;
  const fetcher: WorkFetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    authorization = new Headers(init?.headers).get("authorization");
    return json({ issues: [{
      id: "1", key: "AX-1", fields: {
        summary: secret, description: secret, assignee: { emailAddress: secret },
        status: { name: "Done", statusCategory: { key: "done" } },
        created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z",
        resolutiondate: "2026-01-02T00:00:00Z",
      },
    }], nextPageToken: "next" });
  };
  const api = new JiraWorkSystemApi({
    baseUrl: "https://example.atlassian.net", projectKey: "AX", email: "user@example.test",
    apiToken: "TOKEN", fetcher,
  });
  const result = await api.listArtifacts("WORK_ITEM", { limit: 25 });
  assert.deepEqual(body.fields, ["status", "created", "updated", "resolutiondate"]);
  assert.equal(String(body.jql).includes("AX"), true);
  assert.match(String(authorization), /^Basic /);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.items[0]?.statusCategory, "COMPLETED");
  assert.equal(result.nextCursor, "next");
});

test("Linear GraphQL adapter uses Relay cursors and rejects partial GraphQL errors", async () => {
  const secret = "PRIVATE-LINEAR-CONTENT";
  const bodies: Record<string, unknown>[] = [];
  let fail = false;
  const fetcher: WorkFetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (fail) return json({ data: { issues: { nodes: [] } }, errors: [{ message: secret }] });
    return json({ data: { issues: {
      nodes: [{ id: "id-1", identifier: "AX-1", title: secret, description: secret,
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
        completedAt: null, canceledAt: null, state: { type: "started", name: secret } }],
      pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
    } } });
  };
  const api = new LinearWorkSystemApi({ teamId: "team-id", token: "TOKEN", fetcher });
  const result = await api.listArtifacts("WORK_ITEM", { cursor: "cursor-1", limit: 20 });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.items[0]?.statusCategory, "IN_PROGRESS");
  assert.equal(result.nextCursor, "cursor-2");
  assert.deepEqual((bodies[0]?.variables as Record<string, unknown>).after, "cursor-1");
  assert.equal(String(bodies[0]?.query).includes("title"), false);
  fail = true;
  await assert.rejects(() => api.listArtifacts("WORK_ITEM", { limit: 20 }), /GraphQL returned/u);
});
