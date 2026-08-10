import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJson, sha256, stableId } from "../core/canonical-json.js";

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
  await rename(await writeDurably(path, body), path);
}

/**
 * Create the entry only if nothing holds its name yet.
 *
 * `rename` replaces its destination, so two concurrent receiver requests both passed the existence
 * check and the second silently overwrote the first while the client was told 200. `link` fails
 * with EEXIST instead, which is what a duplicate must report.
 */
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

export class BoundedSpool {
  constructor(
    private readonly root: string,
    private readonly limits = { maximumItems: 10_000, maximumBytes: 256 * 1024 * 1024 },
  ) {
    if (limits.maximumItems < 1 || limits.maximumBytes < 1) throw new Error("spool limits must be positive");
  }

  private async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  private path(id: string): string {
    if (!/^spool_[0-9a-f]{32}$/u.test(id)) throw new Error("invalid spool id");
    return join(this.root, `${id}.json`);
  }

  async append(input: {
    channel: LiveChannel;
    payload: unknown;
    receivedAt: string;
    idempotencyKey?: string;
  }): Promise<{ id: string; duplicate: boolean }> {
    await this.initialize();
    const payloadBody = canonicalJson(input.payload);
    const id = stableId("spool", {
      channel: input.channel,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
    });
    const target = this.path(id);
    try {
      await stat(target);
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
    return { id, duplicate: !await atomicCreate(target, body) };
  }

  async listPending(): Promise<SpoolEnvelope[]> {
    await this.initialize();
    const entries = (await readdir(this.root)).filter((entry) => /^spool_[0-9a-f]{32}\.json$/u.test(entry)).sort();
    const envelopes: SpoolEnvelope[] = [];
    for (const entry of entries) {
      const envelope = JSON.parse(await readFile(join(this.root, entry), "utf8")) as SpoolEnvelope;
      const state = envelope.states.at(-1)?.state;
      if (state === "RECEIVED" || state === "FAILED") envelopes.push(envelope);
    }
    return envelopes;
  }

  async reconcileInterrupted(at: string): Promise<number> {
    await this.initialize();
    const entries = (await readdir(this.root)).filter((entry) => /^spool_[0-9a-f]{32}\.json$/u.test(entry)).sort();
    let reconciled = 0;
    for (const entry of entries) {
      const target = join(this.root, entry);
      const envelope = JSON.parse(await readFile(target, "utf8")) as SpoolEnvelope;
      if (envelope.states.at(-1)?.state !== "PROCESSING") continue;
      const updated: SpoolEnvelope = {
        ...envelope,
        states: [...envelope.states, { state: "FAILED", at, reason: "INTERRUPTED" }],
      };
      await atomicWrite(target, `${canonicalJson(updated)}\n`);
      reconciled += 1;
    }
    return reconciled;
  }

  async transition(id: string, state: "PROCESSING" | "COMPLETED" | "FAILED", at: string, reason?: string): Promise<void> {
    const target = this.path(id);
    const envelope = JSON.parse(await readFile(target, "utf8")) as SpoolEnvelope;
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
  }

  async discardCompleted(id: string): Promise<void> {
    const target = this.path(id);
    const envelope = JSON.parse(await readFile(target, "utf8")) as SpoolEnvelope;
    if (envelope.states.at(-1)?.state !== "COMPLETED") throw new Error("only completed spool entries can be discarded");
    await rm(target, { force: false });
  }

  async deleteWhere(predicate: (envelope: SpoolEnvelope) => boolean): Promise<number> {
    await this.initialize();
    const entries = (await readdir(this.root)).filter((entry) => /^spool_[0-9a-f]{32}\.json$/u.test(entry)).sort();
    let deleted = 0;
    for (const entry of entries) {
      const target = join(this.root, entry);
      const envelope = JSON.parse(await readFile(target, "utf8")) as SpoolEnvelope;
      if (!predicate(envelope)) continue;
      await rm(target, { force: false });
      deleted += 1;
    }
    return deleted;
  }
}
