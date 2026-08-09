import {
  CODEX_THREAD_SOURCE_KINDS,
  type CodexThread,
  type CodexThreadApi,
} from "./types.js";

export interface CodexPaginatedThreads {
  items: readonly CodexThread[];
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION";
  pagesRead: number;
  duplicateCount: number;
}

export async function listAllCodexThreads(
  api: CodexThreadApi,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<CodexPaginatedThreads> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("pageSize must be an integer between 1 and 1000");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new Error("maxPages must be an integer between 1 and 10000");
  }
  const items: CodexThread[] = [];
  const identities = new Set<string>();
  let pagesRead = 0;
  let duplicateCount = 0;
  let partial = false;
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    let complete = false;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await api.listThreads({
        cursor,
        limit: pageSize,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: CODEX_THREAD_SOURCE_KINDS,
        archived,
        useStateDbOnly: true,
      });
      pagesRead += 1;
      for (const thread of response.data) {
        if (!thread.id) throw new Error("Codex thread/list returned a thread without identity");
        if (identities.has(thread.id)) {
          duplicateCount += 1;
          continue;
        }
        identities.add(thread.id);
        items.push(thread);
      }
      if (response.nextCursor === null) {
        complete = true;
        break;
      }
      if (cursors.has(response.nextCursor)) {
        partial = true;
        break;
      }
      cursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    if (!complete) partial = true;
  }
  return {
    items,
    coverage: partial || duplicateCount > 0 ? "PARTIAL_PAGINATION" : "COMPLETE_FOR_RETURNED_VIEW",
    pagesRead,
    duplicateCount,
  };
}
