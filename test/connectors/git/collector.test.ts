import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { collectLocalGit } from "../../../src/connectors/git/collector.js";
import { runWalkingSkeleton } from "../../../src/core/pipeline.js";

function git(repository: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8", env: { ...process.env, ...environment },
  });
}

test("Local Git is an idempotent artifact source and temporal links remain explicitly inferred", async () => {
  const root = await mkdtemp(join(tmpdir(), "axtory-git-collector-"));
  const repository = join(root, "repository");
  const dataDirectory = join(root, "data");
  try {
    await writeFile(join(root, "placeholder"), "synthetic", "utf8");
    execFileSync("git", ["init", "--quiet", repository]);
    git(repository, ["config", "user.name", "Synthetic User"]);
    git(repository, ["config", "user.email", "synthetic@example.invalid"]);
    await writeFile(join(repository, "synthetic-secret-path.txt"), "fixture content", "utf8");
    git(repository, ["add", "synthetic-secret-path.txt"]);
    git(repository, ["commit", "--quiet", "-m", "private synthetic message"], {
      GIT_AUTHOR_DATE: "2026-01-02T03:00:02Z",
      GIT_COMMITTER_DATE: "2026-01-02T03:00:02Z",
    });
    const session = await runWalkingSkeleton({
      fixturePath: resolve("fixtures/synthetic/normal-session.json"), dataDirectory,
      jsonOutputPath: join(dataDirectory, "session-output.json"),
      now: () => new Date("2026-08-09T00:00:00.000Z"), randomId: () => "git-session",
    });
    let sequence = 0;
    const collect = () => collectLocalGit({
      repositoryDirectory: repository, dataDirectory,
      jsonOutputPath: join(dataDirectory, "git-output.json"),
      sessionRevisionId: session.output.sourceRevisionId,
      now: () => new Date("2026-08-09T01:00:00.000Z"), randomId: () => `git-${++sequence}`,
    });
    const first = await collect();
    const second = await collect();
    assert.equal(first.revisionCreated, true);
    assert.equal(second.revisionCreated, false);
    assert.equal(first.commitsReturned, 1);
    assert.equal(first.correlations, 1);
    assert.equal(first.correlationDerivation, "INFERRED");
    const output = await readFile(join(dataDirectory, "git-output.json"), "utf8");
    assert.equal(output.includes("synthetic-secret-path"), false);
    assert.equal(output.includes("private synthetic message"), false);
    assert.equal(output.includes("synthetic@example.invalid"), false);

    const database = new DatabaseSync(join(dataDirectory, "axtory.sqlite3"), { readOnly: true });
    try {
      const source = database.prepare(`SELECT source_type, external_key FROM source_objects
        WHERE source_type = 'LOCAL_GIT'`).get() as { source_type: string; external_key: string };
      assert.equal(source.source_type, "LOCAL_GIT");
      assert.equal(source.external_key.includes(repository), false);
      const relation = database.prepare(`SELECT derivation, record_type, reason FROM analysis_records
        WHERE record_type = 'RELATION' LIMIT 1`).get() as
        { derivation: string; record_type: string; reason: string };
      assert.equal(relation.derivation, "INFERRED");
      assert.match(relation.reason, /authorship and causality are not established/u);
      assert.equal((database.prepare(`SELECT COUNT(*) AS count FROM source_revisions
        WHERE source_object_id = (SELECT id FROM source_objects WHERE source_type = 'LOCAL_GIT')`)
        .get() as { count: number }).count, 1);
      const raw = database.prepare(`SELECT payload_reference FROM raw_observations
        WHERE observation_type = 'GIT_SNAPSHOT'`).get() as { payload_reference: string };
      const payload = await readFile(join(dataDirectory, "blobs", raw.payload_reference), "utf8");
      assert.equal(payload.includes("synthetic-secret-path"), false);
      assert.equal(payload.includes("private synthetic message"), false);
      assert.equal(payload.includes("synthetic@example.invalid"), false);
    } finally {
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
