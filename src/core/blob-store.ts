import { mkdir, open, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { sha256 } from "./canonical-json.js";

export interface BlobReference {
  digest: string;
  relativePath: string;
  byteLength: number;
}

export class ContentAddressedBlobStore {
  constructor(private readonly root: string) {}

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
}
