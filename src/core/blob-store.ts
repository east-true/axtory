import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

import { sha256 } from "./canonical-json.js";

export interface BlobReference {
  digest: string;
  relativePath: string;
  byteLength: number;
}

export class ContentAddressedBlobStore {
  constructor(private readonly root: string) {}

  private path(relativePath: string): string {
    const normalized = normalize(relativePath);
    if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`)) {
      throw new Error("blob reference escapes the blob store");
    }
    return join(this.root, normalized);
  }

  private async verifyBlob(target: string, digest: string, expectedBytes?: number): Promise<Uint8Array> {
    const metadata = await lstat(target);
    if (!metadata.isFile()) throw new Error("blob target is not a regular file");
    if (expectedBytes !== undefined && metadata.size !== expectedBytes) {
      throw new Error("blob content does not match its digest");
    }
    const bytes = await readFile(target);
    if (sha256(bytes) !== digest) throw new Error("blob content does not match its digest");
    return bytes;
  }

  async put(bytes: Uint8Array): Promise<BlobReference> {
    const digest = sha256(bytes);
    const relativePath = join("sha256", digest.slice(0, 2), digest);
    const target = join(this.root, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await this.verifyBlob(target, digest, bytes.byteLength);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, target);
        } catch (linkError) {
          if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError;
          await this.verifyBlob(target, digest, bytes.byteLength);
        }
      } finally {
        await rm(temporary, { force: true });
      }
    }
    return { digest, relativePath, byteLength: bytes.byteLength };
  }

  async remove(relativePath: string): Promise<boolean> {
    try {
      await rm(this.path(relativePath), { force: false });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async read(relativePath: string, maximumBytes: number): Promise<Uint8Array> {
    const target = this.path(relativePath);
    const metadata = await lstat(target);
    if (!metadata.isFile()) throw new Error("blob target is not a regular file");
    if (metadata.size > maximumBytes) throw new Error("blob exceeds the analysis input limit");
    const expectedDigest = basename(relativePath);
    if (!/^[0-9a-f]{64}$/u.test(expectedDigest)) throw new Error("blob reference has an invalid digest");
    return this.verifyBlob(target, expectedDigest);
  }
}
