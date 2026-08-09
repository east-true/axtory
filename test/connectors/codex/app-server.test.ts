import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAppServerClient } from "../../../src/connectors/codex/app-server.js";

test("stdio adapter performs initialization and only exposes read operations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "axtory-codex-app-server-"));
  const executable = join(directory, "fake-codex");
  const fake = `#!/usr/bin/env node
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
const base = { id:"thread", sessionId:"session", forkedFromId:null, parentThreadId:null,
 preview:"", ephemeral:false, modelProvider:"openai", createdAt:1, updatedAt:2, recencyAt:null,
 status:{type:"idle"}, path:null, cwd:"/synthetic", cliVersion:"1.0.0", source:"cli",
 threadSource:null, agentNickname:null, agentRole:null, gitInfo:null, name:null };
rl.on("line", line => {
 const message = JSON.parse(line);
 if (message.method === "initialize") process.stdout.write(JSON.stringify({id:message.id,result:{}})+"\\n");
 if (message.method === "initialized") process.stdout.write(JSON.stringify({id:"reverse",method:"fs/writeFile",params:{}})+"\\n");
 if (message.id === "reverse" && message.error && message.error.code === -32601) process.stderr.write("rejected");
 if (message.method === "thread/list") process.stdout.write(JSON.stringify({id:message.id,result:{data:[{...base,turns:[]}],nextCursor:null}})+"\\n");
 if (message.method === "thread/read") process.stdout.write(JSON.stringify({id:message.id,result:{thread:{...base,turns:[]}}})+"\\n");
});
`;
  try {
    await writeFile(executable, fake, { mode: 0o700 });
    await chmod(executable, 0o700);
    const client = new CodexAppServerClient({ executablePath: executable, codexHome: directory });
    try {
      const listed = await client.listThreads({ useStateDbOnly: true });
      assert.equal(listed.data.length, 1);
      assert.equal((await client.readThread("thread")).id, "thread");
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
