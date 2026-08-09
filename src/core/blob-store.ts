import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";

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

  async put(bytes: Uint8Array): Promise<BlobReference> {
    const digest = sha256(bytes);
    const relativePath = join("sha256", digest.slice(0, 2), digest);
    const target = join(this.root, relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await stat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await rename(temporary, target);
      } catch (renameError) {
        if ((renameError as NodeJS.ErrnoException).code !== "EEXIST") throw renameError;
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
    const metadata = await stat(target);
    if (metadata.size > maximumBytes) throw new Error("blob exceeds the analysis input limit");
    return readFile(target);
  }
}
