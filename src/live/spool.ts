import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { canonicalJson, sha256, stableId } from "../core/canonical-json.js";
import { withDataMutationLock } from "../core/mutation-lock.js";

export type LiveChannel = "CLAUDE_HOOK" | "CLAUDE_OTEL_METRICS" | "CLAUDE_OTEL_LOGS";
export type SpoolState = "STARTED" | "RECEIVED" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface SpoolEnvelope {
  schemaVersion: "axtory.live-spool.v1";
  id: string;
  channel: LiveChannel;
  receivedAt: string;
  payloadDigest: string;
  payload: unknown;
  states: readonly { state: SpoolState; at: string; reason?: string }[];
}

const LIVE_CHANNELS = new Set<LiveChannel>(["CLAUDE_HOOK", "CLAUDE_OTEL_METRICS", "CLAUDE_OTEL_LOGS"]);

async function writeDurably(path: string, body: string): Promise<string> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return temporary;
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = await writeDurably(path, body);
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicCreate(path: string, body: string): Promise<boolean> {
  const temporary = await writeDurably(path, body);
  try {
    await link(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseEnvelope(body: string, expectedId: string): SpoolEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new Error("live spool entry is not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("live spool entry has an invalid envelope");
  }
  const envelope = parsed as Partial<SpoolEnvelope>;
  if (envelope.schemaVersion !== "axtory.live-spool.v1" || envelope.id !== expectedId ||
    typeof envelope.channel !== "string" || !LIVE_CHANNELS.has(envelope.channel as LiveChannel) ||
    typeof envelope.receivedAt !== "string" || typeof envelope.payloadDigest !== "string" ||
    !Array.isArray(envelope.states)) {
    throw new Error("live spool entry has an invalid envelope");
  }
  const actualDigest = sha256(canonicalJson(envelope.payload));
  if (envelope.payloadDigest !== actualDigest) throw new Error("live spool payload does not match its digest");
  return envelope as SpoolEnvelope;
}

async function readEnvelope(path: string, expectedId: string): Promise<SpoolEnvelope> {
  return parseEnvelope(await readFile(path, "utf8"), expectedId);
}

export class BoundedSpool {
  private appendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: string,
    private readonly limits = { maximumItems: 10_000, maximumBytes: 256 * 1024 * 1024 },
  ) {
    if (limits.maximumItems < 1 || limits.maximumBytes < 1) throw new Error("spool limits must be positive");
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  private mutationRoot(): string {
    return basename(this.root) === "spool" ? dirname(this.root) : this.root;
  }

  private path(id: string): string {
    if (!/^spool_[0-9a-f]{32}$/u.test(id)) throw new Error("invalid spool id");
    return join(this.root, `${id}.json`);
  }

  private serializeAppend<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.appendTail.then(operation);
    this.appendTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async append(input: {
    channel: LiveChannel;
    payload: unknown;
    receivedAt: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; duplicate: boolean }> {
    await this.initialize();
    return this.serializeAppend(() => withDataMutationLock(this.mutationRoot(), async () => {
      const payloadBody = canonicalJson(input.payload);
      const id = stableId("spool", {
        channel: input.channel,
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
      });
      const target = this.path(id);
      try {
        await stat(target);
        await readEnvelope(target, id);
        return { id, duplicate: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const entries = (await readdir(this.root)).filter((entry) => /^spool_[0-9a-f]{32}\.json$/u.test(entry));
      let bytes = 0;
      for (const entry of entries) bytes += (await stat(join(this.root, entry))).size;
      const envelope: SpoolEnvelope = {
        schemaVersion: "axtory.live-spool.v1", id, channel: input.channel,
        receivedAt: input.receivedAt, payloadDigest: sha256(payloadBody), payload: input.payload,
        states: [
          { state: "STARTED", at: input.receivedAt },
          { state: "RECEIVED", at: input.receivedAt },
        ],
      };
      const body = `${canonicalJson(envelope)}\n`;
      if (entries.length >= this.limits.maximumItems || bytes + Buffer.byteLength(body) > this.limits.maximumBytes) {
        throw new Error("live spool capacity exceeded");
      }
      const created = await atomicCreate(target, body);
      if (!created) await readEnvelope(target, id);
      return { id, duplicate: !created };
    }));
  }

  async listPending(): Promise<SpoolEnvelope[]> {
    await this.initialize();
    const entries = (await readdir(this.root)).filter((entry) => /^spool_[0-9a-f]{32}\.json$/u.test(entry)).sort();
    const envelopes: SpoolEnvelope[] = [];
    for (const entry of entries) {
      const id = entry.slice(0, -5);
      const envelope = await readEnvelope(join(this.root, entry), id);
      const state = envelope.states.at(-1)?.state;
      if (state === "RECEIVED" || state === "FAILED") envelopes.push(envelope);
    }
    return envelopes;
  }

  async reconcileInterrupted(at: string): Promise<number> {
    await this.initialize();
    return withDataMutationLock(this.mutationRoot(), async () => {
      const entries = (await readdir(this.root)).filter((entry) => /^spool_[0-9a-f]{32}\.json$/u.test(entry)).sort();
      let reconciled = 0;
      for (const entry of entries) {
        const target = join(this.root, entry);
        const id = entry.slice(0, -5);
        const envelope = await readEnvelope(target, id);
        if (envelope.states.at(-1)?.state !== "PROCESSING") continue;
        const updated: SpoolEnvelope = {
          ...envelope,
          states: [...envelope.states, { state: "FAILED", at, reason: "INTERRUPTED" }],
        };
        await atomicWrite(target, `${canonicalJson(updated)}\n`);
        reconciled += 1;
      }
      return reconciled;
    });
  }

  async transition(id: string, state: "PROCESSING" | "COMPLETED" | "FAILED", at: string, reason?: string): Promise<void> {
    return withDataMutationLock(this.mutationRoot(), async () => {
      const target = this.path(id);
      const envelope = await readEnvelope(target, id);
      const current = envelope.states.at(-1)?.state;
      const permitted = state === "PROCESSING"
        ? current === "RECEIVED" || current === "FAILED"
        : current === "PROCESSING";
      if (!permitted) throw new Error(`invalid spool transition ${String(current)} -> ${state}`);
      const updated: SpoolEnvelope = {
        ...envelope,
        states: [...envelope.states, { state, at, ...(reason ? { reason } : {}) }],
      };
      await atomicWrite(target, `${canonicalJson(updated)}\n`);
    });
  }

  async discardCompleted(id: string): Promise<void> {
    return withDataMutationLock(this.mutationRoot(), async () => {
      const target = this.path(id);
      const envelope = await readEnvelope(target, id);
      if (envelope.states.at(-1)?.state !== "COMPLETED") throw new Error("only completed spool entries can be discarded");
      await rm(target, { force: false });
    });
  }

  async matchingPaths(predicate: (envelope: SpoolEnvelope) => boolean): Promise<string[]> {
    await this.initialize();
    const entries = (await readdir(this.root)).filter((entry) => /^spool_[0-9a-f]{32}\.json$/u.test(entry)).sort();
    const paths: string[] = [];
    for (const entry of entries) {
      const target = join(this.root, entry);
      const id = entry.slice(0, -5);
      const envelope = await readEnvelope(target, id);
      if (predicate(envelope)) paths.push(target);
    }
    return paths;
  }

  async deleteWhere(predicate: (envelope: SpoolEnvelope) => boolean): Promise<number> {
    return withDataMutationLock(this.mutationRoot(), async () => {
      const paths = await this.matchingPaths(predicate);
      for (const path of paths) await rm(path, { force: false });
      return paths.length;
    });
  }
}
