import { DatabaseSync } from "node:sqlite";

import { canonicalJson, sha256 } from "./canonical-json.js";
import { writeJsonAtomically } from "./output.js";

export interface JsonExportAudit {
  id: string;
  sink: "JSON_FILE";
  destination: string;
  policyVersion: string;
  recordCount: number;
  classifications: readonly string[];
}

function insertStartedExport(
  databasePath: string,
  audit: JsonExportAudit,
  payloadDigest: string,
  startedAt: string,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    database.prepare(`INSERT INTO export_runs(
      id, sink, destination, policy_version, record_count, classifications_json,
      status, payload_digest, exported_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'STARTED', ?, ?)`).run(
      audit.id, audit.sink, audit.destination, audit.policyVersion, audit.recordCount,
      canonicalJson(audit.classifications), payloadDigest, startedAt,
    );
  } finally {
    database.close();
  }
}

function finishExport(databasePath: string, id: string, status: "COMPLETED" | "FAILED", at: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    const result = database.prepare("UPDATE export_runs SET status = ?, exported_at = ? WHERE id = ?")
      .run(status, at, id);
    if (result.changes !== 1) throw new Error("export audit row disappeared before finalization");
  } finally {
    database.close();
  }
}

/**
 * Publish one JSON sink with a durable audit record already present.
 *
 * SQLite and an arbitrary output filesystem cannot share one transaction. Recording STARTED before
 * the final JSON path can exist guarantees that a crash can leave an interrupted audit, but never a
 * successfully published AXtory JSON file with no ExportRun at all. Normal write failures become
 * FAILED; a failure while marking a published file COMPLETED deliberately leaves STARTED rather than
 * rewriting an uncertain outcome as either success or failure.
 */
export async function writeAuditedJsonAtomically(options: {
  databasePath: string;
  jsonOutputPath: string;
  output: object;
  audit: Omit<JsonExportAudit, "sink" | "destination">;
  now: () => string;
}): Promise<string> {
  const payloadDigest = sha256(canonicalJson(options.output));
  const audit: JsonExportAudit = {
    ...options.audit,
    sink: "JSON_FILE",
    destination: options.jsonOutputPath,
  };
  insertStartedExport(options.databasePath, audit, payloadDigest, options.now());

  let writtenDigest: string;
  try {
    writtenDigest = await writeJsonAtomically(options.jsonOutputPath, options.output);
  } catch (error) {
    try {
      finishExport(options.databasePath, audit.id, "FAILED", options.now());
    } catch (auditError) {
      throw new AggregateError([error, auditError], "JSON export failed and its audit could not be finalized");
    }
    throw error;
  }
  if (writtenDigest !== payloadDigest) {
    throw new Error("JSON export digest changed while publishing");
  }
  finishExport(options.databasePath, audit.id, "COMPLETED", options.now());
  return payloadDigest;
}
