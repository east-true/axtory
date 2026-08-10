import type { WorkArtifact, WorkArtifactKind, WorkSystemApi } from "./types.js";

export interface WorkArtifactEnumeration {
  items: readonly WorkArtifact[];
  coverage: "COMPLETE_FOR_RETURNED_VIEW" | "PARTIAL_PAGINATION";
  pagesRead: number;
  duplicateCount: number;
}

export async function enumerateWorkArtifacts(
  api: WorkSystemApi,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<WorkArtifactEnumeration> {
  const pageSize = options.pageSize ?? 50;
  const maxPages = options.maxPages ?? 100;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("work-system pageSize must be an integer between 1 and 100");
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10_000) {
    throw new Error("work-system maxPages must be an integer between 1 and 10000");
  }
  const items: WorkArtifact[] = [];
  const identities = new Set<string>();
  let pagesRead = 0;
  let duplicateCount = 0;
  let partial = false;
  for (const kind of api.supportedKinds) {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    let complete = false;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await api.listArtifacts(kind, { cursor, limit: pageSize });
      pagesRead += 1;
      for (const item of response.items) {
        if (item.provider !== api.provider || item.scopeIdentity !== api.scopeIdentity || item.kind !== kind) {
          throw new Error("work-system adapter returned an artifact outside its declared scope");
        }
        const identity = `${kind}:${item.externalId}`;
        if (identities.has(identity)) {
          duplicateCount += 1;
          continue;
        }
        identities.add(identity);
        items.push(item);
      }
      if (response.nextCursor === null) {
        complete = true;
        break;
      }
      if (seenCursors.has(response.nextCursor)) {
        partial = true;
        break;
      }
      seenCursors.add(response.nextCursor);
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

export function requireSupportedKind(api: WorkSystemApi, kind: WorkArtifactKind): void {
  if (!api.supportedKinds.includes(kind)) throw new Error(`${api.provider} does not support ${kind}`);
}
