import test from "node:test";
import assert from "node:assert/strict";

import { GeminiCliSourceApi } from "../../../src/connectors/additional-ai/gemini.js";
import type { AdditionalAiCommandRunner } from "../../../src/connectors/additional-ai/command.js";

function runner(stdout: string): AdditionalAiCommandRunner {
  return { run: async () => ({ exitCode: 0, stdout, stderr: "" }) };
}

function api(stdout: string): GeminiCliSourceApi {
  return new GeminiCliSourceApi({
    executablePath: "/synthetic/gemini", projectDirectory: "/synthetic/project", runner: runner(stdout),
  });
}

test("parsing fewer sessions than the CLI declares is reported as a partial list", async () => {
  // The CLI declares three sessions but only two rows match the documented format. Reporting
  // METADATA_ONLY here would present a silently truncated enumeration as a complete one.
  const listed = await api([
    "Available sessions for this project (3)",
    "  first session [aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]",
    "  second session [11111111-2222-3333-4444-555555555555]",
    "  third session rendered in an unexpected shape",
  ].join("\n")).listSessions({ limit: 10 });

  assert.equal(listed.items.length, 2);
  assert.equal(listed.coverage, "PARTIAL_LIMIT");
});

test("a fully parsed list stays metadata-only", async () => {
  const listed = await api([
    "Available sessions for this project (2)",
    "  first session [aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee]",
    "  second session [11111111-2222-3333-4444-555555555555]",
  ].join("\n")).listSessions({ limit: 10 });

  assert.equal(listed.items.length, 2);
  assert.equal(listed.coverage, "METADATA_ONLY");
});

test("a declared list that parses to nothing still fails explicitly", async () => {
  await assert.rejects(
    () => api("Available sessions for this project (3)\n  unexpected\n  rows\n  only").listSessions({ limit: 10 }),
    /format is unsupported/u,
  );
});
