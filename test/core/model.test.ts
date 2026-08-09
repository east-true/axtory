import test from "node:test";
import assert from "node:assert/strict";

import { available, unavailable } from "../../src/core/model.js";

test("available and unavailable values cannot silently collapse to zero", () => {
  assert.deepEqual(available(0), { status: "AVAILABLE", value: 0 });
  assert.deepEqual(unavailable("NOT_CONFIGURED", "OTel is disabled"), {
    status: "NOT_CONFIGURED",
    reason: "OTel is disabled",
  });
  assert.throws(() => unavailable("UNKNOWN", ""), /requires a reason/u);
});
