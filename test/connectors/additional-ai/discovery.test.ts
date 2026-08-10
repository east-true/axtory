import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAdditionalAiSource } from "../../../src/connectors/additional-ai/discovery.js";

test("additional AI discovery distinguishes missing executables from documented Aider history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-additional-discovery-"));
  try {
    const history = join(directory, "history.md");
    await writeFile(history, "history", "utf8");
    const common = {
      projectDirectory: directory, env: { PATH: "" }, platform: "linux" as const,
      now: () => new Date("2026-08-10T00:00:00.000Z"),
    };
    const gemini = await discoverAdditionalAiSource("GEMINI_CLI", common);
    const aider = await discoverAdditionalAiSource("AIDER", { ...common, historyFile: history });
    const capability = (key: string, discovery: typeof gemini) =>
      discovery.capabilityAssessment.capabilities.find((item) => item.key === key)?.availability;
    assert.equal(capability("additional_ai.installation", gemini), "SOURCE_UNAVAILABLE");
    assert.equal(capability("additional_ai.session_enumeration", gemini), "SOURCE_UNAVAILABLE");
    assert.equal(capability("additional_ai.installation", aider), "SOURCE_UNAVAILABLE");
    assert.equal(capability("additional_ai.session_enumeration", aider), "AVAILABLE");
    assert.equal(capability("additional_ai.session_content", aider), "PARTIAL");
    for (const item of gemini.capabilityAssessment.capabilities) {
      if (item.availability !== "AVAILABLE") assert.ok(item.reason);
    }
    assert.equal(JSON.stringify(aider).includes(directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
