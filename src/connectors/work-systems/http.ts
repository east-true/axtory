const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export type WorkFetch = typeof fetch;

export interface JsonRequestOptions {
  method?: "GET" | "POST";
  headers?: Readonly<Record<string, string>>;
  body?: unknown;
  timeoutMs?: number;
}

export interface JsonResponse {
  value: unknown;
  headers: Headers;
}

export function validateApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("work-system API base URL must use HTTPS");
  if (url.username || url.password) throw new Error("work-system API base URL must not contain credentials");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

/**
 * Read a response body while enforcing the size limit as bytes arrive. `content-length` is only a
 * Vendor claim, so buffering the whole body first would let an unbounded response exhaust memory
 * before the limit could reject it.
 */
async function readBoundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error("work-system response exceeds the 16 MiB limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function requestJson(
  fetcher: WorkFetch,
  url: string,
  options: JsonRequestOptions = {},
): Promise<JsonResponse> {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("work-system requests require HTTPS");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  let response: Response;
  try {
    response = await fetcher(target, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "axtory/0.1",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (controller.signal.aborted) throw new Error("work-system request timed out", { cause: error });
    throw new Error("work-system request failed before receiving a response", { cause: error });
  }
  try {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      throw new Error("work-system response exceeds the 16 MiB limit");
    }
    const bytes = await readBoundedBody(response);
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      throw new Error(`work-system API returned HTTP ${response.status}${retry ? " with retry-after" : ""}`);
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, headers: response.headers };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("work-system request timed out", { cause: error });
    if (error instanceof Error && error.message.startsWith("work-system ")) throw error;
    throw new Error("work-system API returned invalid JSON", { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export function record(value: unknown, label = "response"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`work-system ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function array(value: unknown, label = "response"): unknown[] {
  if (!Array.isArray(value)) throw new Error(`work-system ${label} must be an array`);
  return value;
}
