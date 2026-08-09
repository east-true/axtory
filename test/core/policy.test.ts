import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_LOCAL_COLLECTION_POLICY, policyAllows } from "../../src/core/policy.js";

test("default policy keeps sensitive classes local and out of analyzers and exports", () => {
  for (const classification of ["CONVERSATION_CONTENT", "SOURCE_CONTENT", "TOOL_CONTENT", "SECRET", "PERSONAL_DATA"] as const) {
    assert.equal(policyAllows(DEFAULT_LOCAL_COLLECTION_POLICY, classification, "persist"), true);
    assert.equal(policyAllows(DEFAULT_LOCAL_COLLECTION_POLICY, classification, "analyze"), false);
    assert.equal(policyAllows(DEFAULT_LOCAL_COLLECTION_POLICY, classification, "export"), false);
  }
});
