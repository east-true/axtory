import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { generateUsageReport } from "../../src/analysis/usage-report.js";
import { sha256 } from "../../src/core/canonical-json.js";
import type { NormalizedObservation } from "../../src/core/records.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

const PROJECT_A = "/home/someone/project-a";
const PROJECT_B = "/home/someone/project-b";

async function seeded(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "axtory-workspace-scope-"));
  const database = new AxtoryDatabase(join(directory, "axtory.sqlite3"));
  try {
    database.startCollectionRun("collection_workspace", "CLAUDE_CODE", "2026-03-01T00:00:00.000Z");
    // Two Claude sessions in project A, one in project B, one collected before the field existed,
    // and a Codex thread that ran in project A outside a Git working tree, so it records a
    // workspace but no branch.
    const seeds: Array<{
      id: string; source: string; workspace: string | null; branch: string | null;
    }> = [
      { id: "a1", source: "CLAUDE_CODE", workspace: PROJECT_A, branch: "main" },
      { id: "a2", source: "CLAUDE_CODE", workspace: PROJECT_A, branch: "feature" },
      { id: "b1", source: "CLAUDE_CODE", workspace: PROJECT_B, branch: "main" },
      { id: "legacy", source: "CLAUDE_CODE", workspace: null, branch: null },
      { id: "codex-a", source: "CODEX", workspace: PROJECT_A, branch: null },
      // Same branch name in a different repository: a branch scope alone cannot separate them.
      { id: "b-main", source: "CLAUDE_CODE", workspace: PROJECT_B, branch: "main" },
    ];
    for (const [index, seed] of seeds.entries()) {
      const sourceObjectId = `source_${seed.id}`;
      const revisionId = `revision_${seed.id}`;
      const occurredAt = `2026-03-0${index + 1}T00:00:00.000Z`;
      database.upsertSourceObject(sourceObjectId, seed.source, `session-${seed.id}`);
      database.insertRevision({
        id: revisionId, sourceObjectId, contentHash: String(index).padStart(64, "0"),
        collectedAt: occurredAt, sourceModifiedAt: occurredAt,
        normalizerVersion: "workspace-test/1", payloadReference: "blobs/not-retained",
      });
      database.linkCollectionRevision("collection_workspace", sourceObjectId, revisionId, occurredAt);
      const base = {
        sourceRevisionId: revisionId, derivation: "OBSERVED" as const, provenance: "OFFICIAL_API" as const,
        dataClassification: "LOCAL_METADATA" as const, occurredAt, timeQuality: "SOURCE_REPORTED" as const,
      };
      const observations: NormalizedObservation[] = [
        { ...base, id: `obs_session_${seed.id}`, stableKey: "session", kind: "SNAPSHOT",
          payload: {
            messageCoverage: "COMPLETE_FOR_RETURNED_VIEW",
            ...(seed.workspace ? { workspaceIdentity: sha256(seed.workspace) } : {}),
            ...(seed.branch ? { branchIdentity: sha256(seed.branch) } : {}),
          } },
        { ...base, id: `obs_message_${seed.id}`, stableKey: "message:0:user", kind: "CONTENT",
          payload: { role: "user" } },
      ];
      database.insertObservations(observations);
    }
    database.finishCollectionRun("collection_workspace", "COMPLETED", "2026-03-05T00:00:00.000Z");
  } finally {
    database.close();
  }
  return directory;
}

test("a workspace scope narrows the report to sessions from that directory", async () => {
  const directory = await seeded();
  try {
    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      workspaceDirectories: [PROJECT_A],
      now: () => new Date("2026-03-10T00:00:00.000Z"), randomId: () => `workspace-${++sequence}`,
    });
    // Both Claude sessions and the Codex thread ran in project A, so one scope selects all three.
    assert.equal(report.totals.sessions, 3);
    assert.deepEqual(
      report.bySource.filter((item) => item.sessions > 0).map((item) => item.sourceType).sort(),
      ["CLAUDE_CODE", "CODEX"],
      "a workspace scope must select every source that ran in that directory",
    );
    assert.equal(report.scope.requestedWorkspaces, 1);
    assert.equal(report.workspaces.availability, "AVAILABLE");
    assert.equal(report.workspaces.distinctWorkspaces, 1);
    assert.equal(report.workspaces.distinctBranches, 2);
    assert.equal(report.workspaces.sessionsWithoutWorkspace, 0);
    // The Codex thread carries a workspace but no branch, which the branch count reports on its own
    // denominator rather than silently shrinking the distinct-branch total.
    assert.equal(report.workspaces.sessionsWithoutBranch, 1);
    assert.match(report.workspaces.reason!, /no branch/u);

    // The directory the caller named must not survive into the exported report.
    const written = await readFile(join(directory, "usage.json"), "utf8");
    assert.equal(written.includes(PROJECT_A), false);
    assert.equal(written.includes("project-a"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unscoped report counts every workspace and flags revisions that carry none", async () => {
  const directory = await seeded();
  try {
    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      now: () => new Date("2026-03-10T00:00:00.000Z"), randomId: () => `unscoped-${++sequence}`,
    });
    assert.equal(report.totals.sessions, 6);
    assert.equal(report.scope.requestedWorkspaces, 0);
    assert.equal(report.scope.requestedBranches, 0);
    assert.equal(report.workspaces.distinctWorkspaces, 2);
    assert.equal(report.workspaces.distinctBranches, 2);
    assert.equal(report.workspaces.sessionsWithoutWorkspace, 1);
    // The legacy revision and the Codex thread both lack a branch, for different reasons.
    assert.equal(report.workspaces.sessionsWithoutBranch, 2);
    assert.equal(report.workspaces.availability, "PARTIAL");
    assert.match(report.workspaces.reason!, /predate the workspace field/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a workspace nobody worked in is unavailable rather than zero", async () => {
  const directory = await seeded();
  try {
    let sequence = 0;
    const report = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      workspaceDirectories: [resolve("/home/someone/never-used")],
      now: () => new Date("2026-03-10T00:00:00.000Z"), randomId: () => `absent-${++sequence}`,
    });
    assert.equal(report.totals.availability, "SOURCE_UNAVAILABLE");
    assert.equal(report.totals.sessions, null, "an unmatched workspace must not report zero sessions");
    assert.equal(report.workspaces.distinctWorkspaces, null);
    assert.equal(report.workspaces.distinctBranches, null, "no selected branch must not report zero branches");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a branch scope selects that branch and shows when it spans repositories", async () => {
  const directory = await seeded();
  try {
    let sequence = 0;
    const shared = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      branches: ["main"],
      now: () => new Date("2026-03-10T00:00:00.000Z"), randomId: () => `branch-${++sequence}`,
    });
    // "main" exists in both projects, so the scope selects both and the workspace count says so
    // rather than presenting unrelated repositories as one branch.
    assert.equal(shared.totals.sessions, 3);
    assert.equal(shared.workspaces.distinctWorkspaces, 2);
    assert.equal(shared.scope.requestedBranches, 1);

    const paired = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      branches: ["main"], workspaceDirectories: [PROJECT_A],
      now: () => new Date("2026-03-10T00:00:00.000Z"), randomId: () => `paired-${++sequence}`,
    });
    assert.equal(paired.totals.sessions, 1, "a branch paired with its workspace names one unit");
    assert.equal(paired.workspaces.distinctWorkspaces, 1);

    const absent = await generateUsageReport({
      dataDirectory: directory, jsonOutputPath: join(directory, "usage.json"),
      branches: ["never-checked-out"],
      now: () => new Date("2026-03-10T00:00:00.000Z"), randomId: () => `absent-branch-${++sequence}`,
    });
    assert.equal(absent.totals.availability, "SOURCE_UNAVAILABLE");
    assert.equal(absent.totals.sessions, null, "an unmatched branch must not report zero sessions");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
