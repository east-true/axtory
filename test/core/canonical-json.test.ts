import test from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, stableId } from "../../src/core/canonical-json.js";

test("canonical JSON preserves __proto__ as source data instead of treating it as a prototype setter", () => {
  const withPrototypeKey = JSON.parse('{"__proto__":{"source":"vendor"}}') as Record<string, unknown>;
  assert.equal(canonicalJson(withPrototypeKey), '{"__proto__":{"source":"vendor"}}');
  assert.notEqual(stableId("source", withPrototypeKey), stableId("source", {}));
});
