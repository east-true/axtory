import test from "node:test";
import assert from "node:assert/strict";

import { mergeClaudeLiveSettings } from "../../src/live/claude-configuration.js";

const token = "synthetic-token-that-is-at-least-32-characters";

test("a new receiver port replaces the previous AXtory hook instead of stacking a dead one", () => {
  const first = mergeClaudeLiveSettings({
    existing: { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "user-hook" }] }] } },
    endpoint: "http://127.0.0.1:43210", token, enableHooks: true, enableOtel: false,
  });
  // The receiver binds an ephemeral port on each run, so the URL differs every time.
  const second = mergeClaudeLiveSettings({
    existing: first, endpoint: "http://127.0.0.1:51234", token, enableHooks: true, enableOtel: false,
  });

  const hooks = second.hooks as Record<string, unknown[]>;
  for (const event of ["PostToolUse", "Stop", "SessionEnd"]) {
    const axtoryUrls = JSON.stringify(hooks[event]).match(/http:\/\/127\.0\.0\.1:\d+/gu) ?? [];
    assert.deepEqual(axtoryUrls, ["http://127.0.0.1:51234"], `${event} kept a stale receiver endpoint`);
  }
  // A hook the user wrote is never removed by the merge.
  assert.equal(JSON.stringify(second).includes("user-hook"), true);
  assert.equal(hooks.Stop?.length, 2);
});

test("merging the same endpoint twice stays idempotent", () => {
  const once = mergeClaudeLiveSettings({
    existing: {}, endpoint: "http://127.0.0.1:43210", token, enableHooks: true, enableOtel: true,
  });
  const twice = mergeClaudeLiveSettings({
    existing: once, endpoint: "http://127.0.0.1:43210", token, enableHooks: true, enableOtel: true,
  });
  assert.deepEqual(twice, once);
});
