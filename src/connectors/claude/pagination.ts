import type { ClaudeHistoryApi, ClaudeSessionInfo, ClaudeSessionMessage } from "./history-api.js";

export type ReturnedViewCoverage =
  | "COMPLETE_FOR_RETURNED_VIEW"
  | "PARTIAL_PAGINATION"
  | "PARTIAL_SOURCE_CHANGED"
  | "SOURCE_UNAVAILABLE";

export interface PaginatedResult<T> {
  items: readonly T[];
  coverage: ReturnedViewCoverage;
  pagesRead: number;
  duplicateCount: number;
  /** Items the Vendor returned without a stable identity, so overlap dedup could not apply to them. */
  unidentifiedCount: number;
}

interface PaginationOptions {
  pageSize?: number;
  maxPages?: number;
}

/**
 * `FAIL` suits identities the official contract guarantees, such as a session id that also keys the
 * SourceObject. `KEEP_UNDEDUPLICATED` suits optional identities: the occurrence is preserved and the
 * returned view is reported as partial rather than discarding the whole enumeration.
 */
type MissingIdentityPolicy = "FAIL" | "KEEP_UNDEDUPLICATED";

async function collectPages<T>(
  readPage: (limit: number, offset: number) => Promise<readonly T[]>,
  identity: (item: T) => string,
  options: PaginationOptions,
  missingIdentity: MissingIdentityPolicy = "FAIL",
): Promise<PaginatedResult<T>> {
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new Error("pageSize must be an integer between 1 and 1000");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new Error("maxPages must be an integer between 1 and 10000");
  }
  const items: T[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;
  let unidentifiedCount = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const returned = await readPage(pageSize, offset);
    for (const item of returned) {
      const id = identity(item);
      if (id.length === 0) {
        if (missingIdentity === "FAIL") throw new Error("paginated source returned an item without identity");
        unidentifiedCount += 1;
        items.push(item);
        continue;
      }
      if (seen.has(id)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(id);
      items.push(item);
    }
    if (returned.length < pageSize) {
      return {
        items,
        coverage: duplicateCount > 0 || unidentifiedCount > 0
          ? "PARTIAL_PAGINATION"
          : "COMPLETE_FOR_RETURNED_VIEW",
        pagesRead: page + 1,
        duplicateCount,
        unidentifiedCount,
      };
    }
  }
  return {
    items,
    coverage: "PARTIAL_PAGINATION",
    pagesRead: maxPages,
    duplicateCount,
    unidentifiedCount,
  };
}

export function listAllSessions(
  api: ClaudeHistoryApi,
  options: PaginationOptions & { dir?: string } = {},
): Promise<PaginatedResult<ClaudeSessionInfo>> {
  return collectPages(
    (limit, offset) => api.listSessions({
      ...(options.dir ? { dir: options.dir } : {}),
      limit,
      offset,
      includeWorktrees: true,
      includeProgrammatic: true,
    }),
    (item) => item.sessionId,
    options,
  );
}

export function listAllMessages(
  api: ClaudeHistoryApi,
  sessionId: string,
  options: PaginationOptions & { dir?: string } = {},
): Promise<PaginatedResult<ClaudeSessionMessage>> {
  return collectPages(
    (limit, offset) => api.getSessionMessages(sessionId, {
      ...(options.dir ? { dir: options.dir } : {}),
      limit,
      offset,
      includeSystemMessages: true,
    }),
    (item) => item.uuid ?? "",
    options,
    "KEEP_UNDEDUPLICATED",
  );
}
