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
    // Two sessions in project A, one in project B, and one collected before the field existed.
    const seeds: Array<{ id: string; workspace: string | null; branch: string | null }> = [
      { id: "a1", workspace: PROJECT_A, branch: "main" },
      { id: "a2", workspace: PROJECT_A, branch: "feature" },
      { id: "b1", workspace: PROJECT_B, branch: "main" },
      { id: "legacy", workspace: null, branch: null },
    ];
    for (const [index, seed] of seeds.entries()) {
      const sourceObjectId = `source_${seed.id}`;
      const revisionId = `revision_${seed.id}`;
      const occurredAt = `2026-03-0${index + 1}T00:00:00.000Z`;
      database.upsertSourceObject(sourceObjectId, "CLAUDE_CODE", `session-${seed.id}`);
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
    assert.equal(report.totals.sessions, 2);
    assert.equal(report.scope.requestedWorkspaces, 1);
    assert.equal(report.workspaces.availability, "AVAILABLE");
    assert.equal(report.workspaces.distinctWorkspaces, 1);
    assert.equal(report.workspaces.distinctBranches, 2);
    assert.equal(report.workspaces.sessionsWithoutWorkspace, 0);

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
    assert.equal(report.totals.sessions, 4);
    assert.equal(report.scope.requestedWorkspaces, 0);
    assert.equal(report.workspaces.distinctWorkspaces, 2);
    assert.equal(report.workspaces.sessionsWithoutWorkspace, 1);
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
