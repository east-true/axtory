import test from "node:test";
import assert from "node:assert/strict";

import { requestJson, type WorkFetch } from "../../../src/connectors/work-systems/http.js";

test("an undeclared oversized response is stopped while streaming, not after buffering", async () => {
  const megabyte = new Uint8Array(1024 * 1024);
  let deliveredChunks = 0;
  const fetcher: WorkFetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      // No content-length is sent, so the limit can only be enforced as bytes arrive. An unbounded
      // producer must be cut off rather than buffered whole.
      deliveredChunks += 1;
      controller.enqueue(megabyte);
    },
  }), { status: 200 });

  await assert.rejects(() => requestJson(fetcher, "https://example.test/data"), /16 MiB/u);
  assert.ok(deliveredChunks <= 24, `stream was not cut off promptly: ${deliveredChunks} chunks`);
});

test("a response within the limit is still read completely", async () => {
  const body = JSON.stringify({ items: Array.from({ length: 500 }, (_value, index) => index) });
  const fetcher: WorkFetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(body);
      controller.enqueue(bytes.slice(0, 100));
      controller.enqueue(bytes.slice(100));
      controller.close();
    },
  }), { status: 200 });
  const response = await requestJson(fetcher, "https://example.test/data");
  assert.deepEqual(response.value, JSON.parse(body));
});
