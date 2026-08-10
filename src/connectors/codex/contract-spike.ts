import { listAllCodexThreads } from "./pagination.js";
import type { CodexThreadApi } from "./types.js";

export interface CodexContractSpikeReport {
  schemaVersion: "axtory.codex-contract-spike.v1";
  generatedAt: string;
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION";
  threadCount: number;
  pagesRead: number;
  activeThreadCount: number;
  forkLinkCount: number;
  parentLinkCount: number;
  fullTurnViewCount: number;
  partialTurnViewCount: number;
  sourceKinds: Readonly<Record<string, number>>;
  itemTypes: Readonly<Record<string, number>>;
  limitations: readonly string[];
}

function sourceKind(value: unknown): string {
  if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("subAgent" in value) return "subAgent";
    if ("custom" in value) return "custom";
  }
  return "unknown";
}

export async function runCodexContractSpike(
  api: CodexThreadApi,
  options: { pageSize?: number; maxPages?: number; threadLimit?: number; now?: () => Date } = {},
): Promise<CodexContractSpikeReport> {
  const listed = await listAllCodexThreads(api, {
    ...(options.pageSize ? { pageSize: options.pageSize } : {}),
    ...(options.maxPages ? { maxPages: options.maxPages } : {}),
  });
  const threadLimit = options.threadLimit ?? 25;
  if (!Number.isInteger(threadLimit) || threadLimit < 1 || threadLimit > 100) {
    throw new Error("threadLimit must be an integer between 1 and 100");
  }
  const sourceKinds: Record<string, number> = {};
  const itemTypes: Record<string, number> = {};
  let activeThreadCount = 0;
  let forkLinkCount = 0;
  let parentLinkCount = 0;
  let fullTurnViewCount = 0;
  let partialTurnViewCount = 0;
  for (const summary of listed.items.slice(0, threadLimit)) {
    const kind = sourceKind(summary.source);
    sourceKinds[kind] = (sourceKinds[kind] ?? 0) + 1;
    if (summary.status?.type === "active") activeThreadCount += 1;
    if (summary.forkedFromId) forkLinkCount += 1;
    if (summary.parentThreadId) parentLinkCount += 1;
    const detail = await api.readThread(summary.id);
    for (const turn of detail.turns) {
      if (turn.itemsView === "full") fullTurnViewCount += 1;
      else partialTurnViewCount += 1;
      for (const item of turn.items) {
        const type = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(item.type) ? item.type : "unknown";
        itemTypes[type] = (itemTypes[type] ?? 0) + 1;
      }
    }
  }
  return {
    schemaVersion: "axtory.codex-contract-spike.v1",
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    coverage: listed.coverage,
    threadCount: listed.items.length,
    pagesRead: listed.pagesRead,
    activeThreadCount,
    forkLinkCount,
    parentLinkCount,
    fullTurnViewCount,
    partialTurnViewCount,
    sourceKinds,
    itemTypes,
    limitations: [
      `Only the first ${threadLimit} returned threads were structurally inspected.`,
      "Counts describe a read-only state snapshot and returned thread views, not execution outcomes.",
      "No identifiers, paths, prompts, responses, tool arguments, or tool output are retained.",
    ],
  };
}

export function assertSanitizedCodexReport(report: CodexContractSpikeReport): void {
  const allowed = new Set([
    "schemaVersion", "generatedAt", "coverage", "threadCount", "pagesRead", "activeThreadCount",
    "forkLinkCount", "parentLinkCount", "fullTurnViewCount", "partialTurnViewCount", "sourceKinds",
    "itemTypes", "limitations",
  ]);
  if (Object.keys(report).some((key) => !allowed.has(key))) {
    throw new Error("Codex contract report contains a non-allowlisted field");
  }
}
