import test from "node:test";
import assert from "node:assert/strict";

import { GitHubWorkSystemApi } from "../../../src/connectors/work-systems/github.js";
import { JiraWorkSystemApi } from "../../../src/connectors/work-systems/jira.js";
import type { WorkFetch } from "../../../src/connectors/work-systems/http.js";

function json(value: unknown, headers: Record<string, string> = {}): WorkFetch {
  return async () => new Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json", ...headers },
  });
}

test("a pull request without the Vendor id fails instead of keying on its number", async () => {
  // `id` and `number` are different namespaces. Falling back would key the SourceObject on whichever
  // field happened to be present, splitting one artifact across runs and double counting it.
  const api = new GitHubWorkSystemApi({
    owner: "synthetic", repository: "repository",
    fetcher: json([{ number: 41, state: "open", created_at: "2026-08-09T00:00:00Z" }]),
  });
  await assert.rejects(
    () => api.listArtifacts("CHANGE_REQUEST", { limit: 10 }),
    /pull request id is missing or invalid/u,
  );
});

test("a Jira issue without the Vendor id fails instead of keying on its plaintext key", async () => {
  const api = new JiraWorkSystemApi({
    baseUrl: "https://synthetic.test", projectKey: "PROJ",
    fetcher: json({ issues: [{ key: "PROJ-123", fields: { status: {} } }] }),
  });
  await assert.rejects(
    () => api.listArtifacts("WORK_ITEM", { limit: 10 }),
    /issue id is missing or invalid/u,
  );
});

test("the Vendor id keys the artifact when it is present", async () => {
  const api = new GitHubWorkSystemApi({
    owner: "synthetic", repository: "repository",
    fetcher: json([{ id: 900123, number: 41, state: "open", created_at: "2026-08-09T00:00:00Z" }]),
  });
  const result = await api.listArtifacts("CHANGE_REQUEST", { limit: 10 });
  assert.equal(result.items[0]?.externalId, "900123");
});
