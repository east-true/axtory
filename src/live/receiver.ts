import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { ensureAxtoryDataDirectory } from "../core/data-directory.js";
import { BoundedSpool, type LiveChannel } from "./spool.js";

export interface LiveReceiver {
  endpoint: string;
  token: string;
  stop(): Promise<void>;
}

function send(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maximumBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("INVALID_JSON", { cause: error });
  }
}

function channelFor(path: string): LiveChannel | null {
  if (/^\/hooks\/[A-Za-z][A-Za-z0-9]{0,63}$/u.test(path)) return "CLAUDE_HOOK";
  if (path === "/v1/metrics") return "CLAUDE_OTEL_METRICS";
  if (path === "/v1/logs") return "CLAUDE_OTEL_LOGS";
  return null;
}

export async function startLiveReceiver(options: {
  dataDirectory: string;
  port?: number;
  token?: string;
  maximumRequestsPerMinute?: number;
  maximumSpoolItems?: number;
  maximumSpoolBytes?: number;
  now?: () => Date;
}): Promise<LiveReceiver> {
  const now = options.now ?? (() => new Date());
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (token.length < 32) throw new Error("live receiver token must contain at least 32 characters");
  const maximumRequestsPerMinute = options.maximumRequestsPerMinute ?? 600;
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const spool = new BoundedSpool(join(dataDirectory, "spool"), {
    maximumItems: options.maximumSpoolItems ?? 10_000,
    maximumBytes: options.maximumSpoolBytes ?? 256 * 1024 * 1024,
  });
  let windowStarted = now().getTime();
  let requestCount = 0;
  const server: Server = createServer(async (request, response) => {
    try {
      const current = now().getTime();
      if (current - windowStarted >= 60_000) {
        windowStarted = current;
        requestCount = 0;
      }
      requestCount += 1;
      if (requestCount > maximumRequestsPerMinute) return send(response, 429, { error: "rate_limit" });
      if (request.headers.authorization !== `Bearer ${token}`) return send(response, 401, { error: "unauthorized" });
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.method === "GET" && path === "/health") return send(response, 200, { status: "ok" });
      const channel = request.method === "POST" ? channelFor(path) : null;
      if (!channel) return send(response, 404, { error: "not_found" });
      if (!String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
        return send(response, 415, { error: "json_required" });
      }
      const payload = await readJson(request, channel === "CLAUDE_HOOK" ? 1024 * 1024 : 4 * 1024 * 1024);
      const result = await spool.append({
        channel, payload, receivedAt: now().toISOString(),
        ...(typeof request.headers["x-request-id"] === "string"
          ? { idempotencyKey: request.headers["x-request-id"].slice(0, 256) }
          : {}),
      });
      return send(response, 200, channel === "CLAUDE_HOOK"
        ? {}
        : { partialSuccess: {}, duplicate: result.duplicate });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      return send(response, message === "REQUEST_TOO_LARGE" ? 413 : message === "INVALID_JSON" ? 400 : 507, {
        error: message === "REQUEST_TOO_LARGE" ? "request_too_large" :
          message === "INVALID_JSON" ? "invalid_json" : "spool_unavailable",
      });
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("live receiver did not bind a TCP port");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    stop: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}
