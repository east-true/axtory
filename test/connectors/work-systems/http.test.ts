import test from "node:test";
import assert from "node:assert/strict";

import { requestJson, validateApiBaseUrl, type WorkFetch } from "../../../src/connectors/work-systems/http.js";

test("work-system HTTP boundary requires HTTPS and keeps response bodies out of errors", async () => {
  assert.throws(() => validateApiBaseUrl("http://example.test"), /HTTPS/u);
  assert.throws(() => validateApiBaseUrl("https://user:secret@example.test"), /must not contain credentials/u);
  const secret = "PRIVATE-ERROR-BODY";
  const fetcher: WorkFetch = async () => new Response(secret, { status: 401 });
  await assert.rejects(async () => {
    try {
      await requestJson(fetcher, "https://example.test/private", { headers: { Authorization: "Bearer TOKEN" } });
    } catch (error) {
      assert.equal(String(error).includes(secret), false);
      assert.equal(String(error).includes("TOKEN"), false);
      throw error;
    }
  }, /HTTP 401/u);
});

test("declared oversized responses are rejected before JSON parsing", async () => {
  const fetcher: WorkFetch = async () => new Response("{}", {
    status: 200, headers: { "content-length": String(17 * 1024 * 1024) },
  });
  await assert.rejects(() => requestJson(fetcher, "https://example.test/data"), /16 MiB/u);
});

test("work-system timeout remains active while the response body is read", async () => {
  const fetcher: WorkFetch = async (_input, init) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      },
    });
    return new Response(stream, { status: 200 });
  };
  await assert.rejects(
    () => requestJson(fetcher, "https://example.test/slow", { timeoutMs: 5 }),
    /request timed out/u,
  );
});
