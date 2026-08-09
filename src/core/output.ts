import { mkdir, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJson, sha256 } from "./canonical-json.js";
import type { AnalysisRecord } from "./records.js";

export const OUTPUT_POLICY_VERSION = "local-facts/1";

export interface SkeletonOutput {
  schemaVersion: "axtory.walking-skeleton-output.v1";
  collectionRunId: string;
  sourceRevisionId: string;
  revisionCreated: boolean;
  coverage: "COMPLETE_FOR_RETURNED_VIEW";
  metrics: readonly {
    key: string;
    value: unknown;
    unit: string | null;
    derivation: "CALCULATED";
    availability: string;
    evidenceCount: number;
  }[];
}

export function applyOutputPolicy(
  collectionRunId: string,
  sourceRevisionId: string,
  revisionCreated: boolean,
  records: readonly AnalysisRecord[],
): SkeletonOutput {
  const metrics = records
    .filter((item) => item.recordType === "METRIC" && item.derivation === "CALCULATED")
    .map((item) => ({
      key: item.key,
      value: item.value,
      unit: item.unit,
      derivation: item.derivation as "CALCULATED",
      availability: item.availability,
      evidenceCount: item.evidenceIds.length,
    }));
  return {
    schemaVersion: "axtory.walking-skeleton-output.v1",
    collectionRunId,
    sourceRevisionId,
    revisionCreated,
    coverage: "COMPLETE_FOR_RETURNED_VIEW",
    metrics,
  };
}

export function renderConsole(output: SkeletonOutput): string {
  const clean = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u009B]/gu, "");
  const lines = ["AXtory fixture analysis", `Coverage: ${output.coverage}`];
  for (const metric of output.metrics) {
    lines.push(`${clean(metric.key)}: ${String(metric.value)} ${metric.unit ?? ""} [${metric.derivation}]`);
  }
  return `${lines.join("\n").slice(0, 16_384)}\n`;
}

export async function writeJsonAtomically(path: string, output: object): Promise<string> {
  const body = `${JSON.stringify(output, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  return sha256(canonicalJson(output));
}
