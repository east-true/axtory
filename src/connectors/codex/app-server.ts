import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  CodexThread,
  CodexThreadApi,
  CodexThreadListParams,
  CodexThreadListResponse,
} from "./types.js";

const MAX_PROTOCOL_LINE_BYTES = 72 * 1024 * 1024;

interface RpcMessage {
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Codex App Server returned an unexpected response shape");
  }
  return value as Record<string, unknown>;
}

function validateThread(value: unknown): CodexThread {
  const item = object(value);
  if (typeof item.id !== "string" || typeof item.sessionId !== "string" ||
      typeof item.updatedAt !== "number" || !Array.isArray(item.turns)) {
    throw new Error("Codex App Server returned an invalid thread");
  }
  return item as unknown as CodexThread;
}

export interface CodexAppServerOptions {
  executablePath: string;
  codexHome: string;
  requestTimeoutMs?: number;
}

function isolatedEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CODEX_HOME: codexHome };
  for (const key of [
    "PATH", "Path", "PATHEXT", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP",
    "SYSTEMROOT", "SystemRoot", "WINDIR", "ComSpec", "NO_COLOR",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

export class CodexAppServerClient implements CodexThreadApi {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;
  private nextId = 1;
  private stdoutBuffer = Buffer.alloc(0);
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private initialized = false;
  private initialization: Promise<void>;

  constructor(options: CodexAppServerOptions) {
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    this.process = spawn(options.executablePath, ["app-server", "--stdio"], {
      env: isolatedEnvironment(options.codexHome),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.process.stderr.resume();
    this.process.once("error", () => this.failAll("Codex App Server could not be started"));
    this.process.once("exit", () => this.failAll("Codex App Server exited before completing the request"));
    this.initialization = this.initialize();
    // A spawn failure rejects this promise before any caller can await it. Marking it handled here
    // keeps the rejection reportable at the call site instead of crashing the process.
    void this.initialization.catch(() => undefined);
  }

  private write(message: unknown): void {
    if (this.closed || !this.process.stdin.writable) throw new Error("Codex App Server is closed");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private request(method: string, params: unknown, initialize = false): Promise<unknown> {
    if (!initialize && !this.initialized) throw new Error("Codex App Server is not initialized");
    if (!initialize && method !== "thread/list" && method !== "thread/read") {
      throw new Error("Codex App Server method is outside AXtory's read-only allowlist");
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server ${method} request timed out`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "axtory", title: "AXtory", version: "0.1.0" },
      capabilities: null,
    }, true);
    this.write({ method: "initialized" });
    this.initialized = true;
  }

  private onData(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.byteLength > MAX_PROTOCOL_LINE_BYTES && this.stdoutBuffer.indexOf(0x0a) < 0) {
      this.failAll("Codex App Server response exceeded the 72 MiB protocol limit");
      void this.close();
      return;
    }
    let newline = this.stdoutBuffer.indexOf(0x0a);
    while (newline >= 0) {
      const line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.byteLength > MAX_PROTOCOL_LINE_BYTES) {
        this.failAll("Codex App Server response exceeded the 72 MiB protocol limit");
        void this.close();
        return;
      }
      if (line.byteLength > 0) this.onLine(line.toString("utf8"));
      newline = this.stdoutBuffer.indexOf(0x0a);
    }
  }

  private onLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.failAll("Codex App Server returned invalid NDJSON");
      return;
    }
    if (message.method && message.id !== undefined) {
      try {
        this.write({ id: message.id, error: { code: -32601, message: "AXtory rejects server-initiated requests" } });
      } catch {
        // Buffered stdout can still deliver a server-initiated request after stdin closed. Refusing
        // it is best effort; throwing out of this stream listener would be an uncaught exception.
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      // The server explains itself; dropping that text leaves a bare code that says nothing about
      // what to do. An older App Server refusing a whole-thread read reports "paginated threads do
      // not support thread/read(includeTurns=true)", which names the incompatibility, while the
      // code alone reads as a generic protocol fault. The text is Vendor diagnostics rather than
      // conversation content, so it is bounded and passed through instead of being discarded.
      const detail = typeof message.error.message === "string" && message.error.message.length > 0
        ? `: ${message.error.message.slice(0, 300)}`
        : "";
      pending.reject(new Error(
        `Codex App Server request failed with code ${message.error.code ?? "unknown"}${detail}`,
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  private failAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  async listThreads(params: CodexThreadListParams): Promise<CodexThreadListResponse> {
    await this.initialization;
    const response = object(await this.request("thread/list", params));
    if (!Array.isArray(response.data) ||
        !(response.nextCursor === null || typeof response.nextCursor === "string")) {
      throw new Error("Codex App Server returned an invalid thread/list response");
    }
    return {
      data: response.data.map(validateThread),
      nextCursor: response.nextCursor,
      ...(response.backwardsCursor === null || typeof response.backwardsCursor === "string"
        ? { backwardsCursor: response.backwardsCursor }
        : {}),
    };
  }

  async readThread(threadId: string): Promise<CodexThread> {
    if (!threadId) throw new Error("Codex thread/read requires a thread ID");
    await this.initialization;
    const response = object(await this.request("thread/read", { threadId, includeTurns: true }));
    return validateThread(response.thread);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.failAll("Codex App Server was closed");
    this.process.stdin.end();
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.closePromise = new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };
      const forceTimer = setTimeout(() => {
        if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
      }, 2_000);
      this.process.once("exit", finish);
      this.process.once("error", finish);
      if (this.process.exitCode !== null || this.process.signalCode !== null) finish();
      else this.process.kill("SIGTERM");
    });
    return this.closePromise;
  }
}
