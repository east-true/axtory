import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { writeAuditedJsonAtomically } from "../../src/core/export.js";
import { AxtoryDatabase } from "../../src/core/storage.js";

function exportRow(databasePath: string, id: string): { status: string; payload_digest: string } {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare("SELECT status, payload_digest FROM export_runs WHERE id = ?").get(id) as {
      status: string; payload_digest: string;
    };
  } finally {
    database.close();
  }
}

test("a JSON export has a durable audit lifecycle before and after publication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-export-audit-"));
  const databasePath = join(directory, "axtory.sqlite3");
  const target = join(directory, "output.json");
  try {
    new AxtoryDatabase(databasePath).close();
    let tick = 0;
    const digest = await writeAuditedJsonAtomically({
      databasePath,
      jsonOutputPath: target,
      output: { value: 1 },
      audit: {
        id: "export_success",
        policyVersion: "test/1",
        recordCount: 1,
        classifications: ["LOCAL_METADATA"],
      },
      now: () => `2026-08-14T00:00:0${tick++}.000Z`,
    });

    const row = exportRow(databasePath, "export_success");
    assert.equal(row.status, "COMPLETED");
    assert.equal(row.payload_digest, digest);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed JSON publication leaves a FAILED audit instead of no ExportRun", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-export-audit-failure-"));
  const databasePath = join(directory, "axtory.sqlite3");
  const target = join(directory, "output.json");
  try {
    new AxtoryDatabase(databasePath).close();
    await mkdir(target);
    let tick = 0;
    await assert.rejects(writeAuditedJsonAtomically({
      databasePath,
      jsonOutputPath: target,
      output: { value: 2 },
      audit: {
        id: "export_failed",
        policyVersion: "test/1",
        recordCount: 1,
        classifications: ["LOCAL_METADATA"],
      },
      now: () => `2026-08-14T00:01:0${tick++}.000Z`,
    }));

    assert.equal(exportRow(databasePath, "export_failed").status, "FAILED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
