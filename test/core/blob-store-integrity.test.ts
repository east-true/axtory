import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ContentAddressedBlobStore } from "../../src/core/blob-store.js";

test("blob reads and repeated puts reject content that no longer matches its digest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-blob-integrity-"));
  try {
    const store = new ContentAddressedBlobStore(directory);
    const original = Buffer.from("original");
    const reference = await store.put(original);
    assert.deepEqual(await store.put(original), reference);
    await writeFile(join(directory, reference.relativePath), Buffer.from("tampered"));

    await assert.rejects(
      store.read(reference.relativePath, 1024),
      /does not match its digest/u,
    );
    await assert.rejects(
      store.put(original),
      /does not match its digest/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a directory cannot impersonate a content-addressed blob", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-blob-file-type-"));
  try {
    const store = new ContentAddressedBlobStore(directory);
    const bytes = Buffer.from("synthetic");
    const reference = await store.put(bytes);
    const target = join(directory, reference.relativePath);
    await rm(target);
    await mkdir(target);

    await assert.rejects(store.put(bytes), /not a regular file/u);
    await assert.rejects(store.read(reference.relativePath, 1024), /not a regular file/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a symbolic link cannot impersonate a content-addressed blob", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-blob-symlink-"));
  try {
    const store = new ContentAddressedBlobStore(directory);
    const bytes = Buffer.from("synthetic");
    const reference = await store.put(bytes);
    const target = join(directory, reference.relativePath);
    const external = join(directory, "external-payload");
    await rm(target);
    await writeFile(external, bytes);
    await symlink(external, target, "file");

    await assert.rejects(store.put(bytes), /not a regular file/u);
    await assert.rejects(store.read(reference.relativePath, 1024), /not a regular file/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
