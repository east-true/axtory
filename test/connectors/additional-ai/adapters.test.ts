import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AiderSourceApi } from "../../../src/connectors/additional-ai/aider.js";
import type { AdditionalAiCommandRunner } from "../../../src/connectors/additional-ai/command.js";
import { CursorSourceApi } from "../../../src/connectors/additional-ai/cursor.js";
import { GeminiCliSourceApi } from "../../../src/connectors/additional-ai/gemini.js";
import { sha256 } from "../../../src/core/canonical-json.js";
import { OpenCodeSourceApi } from "../../../src/connectors/additional-ai/opencode.js";

test("Gemini session lists retain IDs but discard preview content", async () => {
  const secret = "PRIVATE-LIST-PREVIEW";
  const runner: AdditionalAiCommandRunner = {
    async run(_command, args) {
      if (args[0] === "--list-sessions") return {
        exitCode: 0, stderr: "",
        stdout: `Available sessions for this project (2):\n1. ${secret} [12345678-abcd-1234-abcd-123456789abc]\n2. ${secret} [87654321-dcba-4321-dcba-cba987654321]\n`,
      };
      return {
        exitCode: 0, stderr: "",
        stdout: `${secret}\n12345678-abcd-1234-abcd-123456789abc\n87654321-dcba-4321-dcba-cba987654321\n`,
      };
    },
  };
  const gemini = new GeminiCliSourceApi({ executablePath: "gemini", projectDirectory: "/project", runner });
  const geminiList = await gemini.listSessions({ limit: 1 });
  assert.equal(geminiList.coverage, "PARTIAL_LIMIT");
  const view = await gemini.readSession(geminiList.items[0]!);
  assert.equal(JSON.stringify([geminiList, view]).includes(secret), false);
  assert.equal(view.coverage, "METADATA_ONLY");
  assert.equal(view.messages.length, 0);
});

test("Cursor Agent enumeration fails explicitly instead of driving an interactive picker", async () => {
  const runner: AdditionalAiCommandRunner = {
    async run() {
      throw new Error("the adapter must not spawn the CLI to enumerate sessions");
    },
  };
  const cursor = new CursorSourceApi({ executablePath: "cursor-agent", projectDirectory: "/project", runner });
  // `cursor-agent ls` is documented as "Resume a chat session" and blocks on stdin, so spawning it
  // would spend the timeout on every collection and then blame a slow command.
  await assert.rejects(() => cursor.listSessions({ limit: 1 }), /no non-interactive session listing/u);
});

test("a Cursor summary obtained elsewhere still reads as metadata only", async () => {
  const cursor = new CursorSourceApi({ executablePath: "cursor-agent", projectDirectory: "/project" });
  const view = await cursor.readSession({
    provider: "CURSOR", scopeIdentity: cursor.scopeIdentity,
    externalId: "12345678-abcd-1234-abcd-123456789abc", createdAt: null, sourceUpdatedAt: null,
  });
  assert.equal(view.coverage, "METADATA_ONLY");
  assert.deepEqual(view.messages, []);
  // The summary keeps the Vendor id because the collector needs it to key the SourceObject; the
  // raw view that reaches the blob store carries only its hash.
  assert.equal(JSON.stringify(view.rawPayload).includes("12345678-abcd-1234-abcd-123456789abc"), false);
  assert.match(
    String((view.rawPayload as { sessionIdentity: string }).sessionIdentity), /^[0-9a-f]{64}$/u,
  );
});

test("OpenCode uses pure JSON list/export commands and preserves source-change coverage", async () => {
  const secret = "PRIVATE-OPENCODE-CONTENT";
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const runner: AdditionalAiCommandRunner = {
    async run(_command, args, options) {
      calls.push({ args, env: options.env });
      if (args.includes("list")) return {
        exitCode: 0, stderr: "",
        stdout: JSON.stringify([{ id: "ses_1234", title: secret, created: 1_700_000_000_000, updated: 1_700_000_001_000 }]),
      };
      return {
        exitCode: 0, stderr: "Exporting session", stdout: JSON.stringify({
          info: { id: "ses_1234", title: secret, directory: secret, time: { created: 1_700_000_000_000, updated: 1_700_000_002_000 } },
          messages: [{
            info: { id: "msg_1234", role: "assistant", time: { created: 1_700_000_001_500 } },
            parts: [{ id: "part_1", type: "text", text: secret }, { id: "part_2", type: "tool", state: { output: secret } }],
          }],
        }),
      };
    },
  };
  const api = new OpenCodeSourceApi({ executablePath: "opencode", projectDirectory: "/project", runner });
  const listed = await api.listSessions({ limit: 10 });
  const view = await api.readSession(listed.items[0]!);
  assert.equal(view.coverage, "PARTIAL_SOURCE_CHANGED");
  assert.equal(view.messages[0]?.role, "ASSISTANT");
  assert.deepEqual(view.messages[0]?.partTypes, ["text", "tool"]);
  assert.equal(JSON.stringify(view.rawPayload).includes(secret), true);
  assert.deepEqual(calls[0]?.args.slice(0, 2), ["--pure", "session"]);
  assert.deepEqual(calls[1]?.args.slice(0, 2), ["--pure", "export"]);
  assert.equal(calls.every((call) => call.env?.OPENCODE_DISABLE_AUTOUPDATE === "true" &&
    call.env?.OPENCODE_DISABLE_PRUNE === "true"), true);
});

test("OpenCode records the session directory as a digest and nothing else", async () => {
  const workspace = "/home/someone/project-a";
  const runner: AdditionalAiCommandRunner = {
    async run(_command, args) {
      if (args.includes("list")) return {
        exitCode: 0, stderr: "",
        stdout: JSON.stringify([
          { id: "ses_with_dir", title: "t", directory: workspace, created: 1, updated: 2 },
          { id: "ses_no_dir", title: "t", created: 1, updated: 2 },
        ]),
      };
      throw new Error("unexpected command");
    },
  };
  const api = new OpenCodeSourceApi({ executablePath: "opencode", projectDirectory: "/project", runner });
  const listed = await api.listSessions({ limit: 10 });

  // The digest must equal the one another connector computes for the same absolute directory, so
  // sessions from different providers group into one workspace.
  assert.equal(listed.items[0]?.workspaceIdentity, sha256(workspace));
  assert.equal(listed.items[0]?.workspaceIdentity?.includes("project-a"), false);
  // A summary without a directory carries no workspace rather than an invented one.
  assert.equal(listed.items[1]?.workspaceIdentity, undefined);
});

test("Aider reads only an explicit documented chat history file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-aider-"));
  try {
    const history = join(directory, ".aider.chat.history.md");
    await writeFile(history, "PRIVATE-AIDER-CONTENT", "utf8");
    const api = new AiderSourceApi({ projectDirectory: directory, historyFile: history });
    const listed = await api.listSessions({ limit: 1 });
    const view = await api.readSession(listed.items[0]!);
    assert.equal(view.coverage, "UNKNOWN");
    assert.equal(view.provenance, "DOCUMENTED_STORAGE");
    assert.equal(JSON.stringify(view.rawPayload).includes("PRIVATE-AIDER-CONTENT"), true);
    assert.equal(JSON.stringify(listed).includes(directory), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
