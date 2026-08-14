import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { CodexAppServerClient } from "../../../src/connectors/codex/app-server.js";

test("thread/read rejects a response for a different thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-thread-scope-"));
  const executable = join(directory, "fake-codex");
  const fake = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const thread = { id:"other-thread", sessionId:"session", forkedFromId:null, parentThreadId:null,
 preview:"", ephemeral:false, modelProvider:"openai", createdAt:1, updatedAt:2, recencyAt:null,
 status:{type:"idle"}, path:null, cwd:"/synthetic", cliVersion:"1.0.0", source:"cli",
 threadSource:null, agentNickname:null, agentRole:null, gitInfo:null, name:null, turns:[] };
rl.on("line", line => {
 const message = JSON.parse(line);
 if (message.method === "initialize") process.stdout.write(JSON.stringify({id:message.id,result:{}})+"\\n");
 if (message.method === "thread/read") process.stdout.write(JSON.stringify({id:message.id,result:{thread}})+"\\n");
});
`;
  try {
    await writeFile(executable, fake, { mode: 0o700 });
    await chmod(executable, 0o700);
    const client = new CodexAppServerClient({ executablePath: executable, codexHome: directory });
    try {
      await assert.rejects(client.readThread("requested-thread"), /returned a different thread/u);
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
