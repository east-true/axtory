#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { assertSanitizedReport, runClaudeContractSpike } from
  "../src/connectors/claude/contract-spike.js";
import { discoverClaude } from "../src/connectors/claude/discovery.js";
import { loadClaudeHistoryApi } from "../src/connectors/claude/history-api.js";

function outputPath(args: readonly string[]): string {
  const index = args.indexOf("--output");
  const value = index >= 0 ? args[index + 1] : undefined;
  return value ?? "local-spike-results/claude.json";
}

const discovery = await discoverClaude();
const api = await loadClaudeHistoryApi();
const contract = await runClaudeContractSpike(api);
assertSanitizedReport(contract);
const report = {
  schemaVersion: "axtory.claude-local-spike.v1",
  discovery: {
    environmentType: discovery.environment.type,
    os: discovery.environment.os,
    architecture: discovery.environment.architecture,
    executableAvailability: discovery.sourceProfile.executablePath.status,
    version: discovery.sourceProfile.activeVersion,
    dataRootAvailability: discovery.sourceProfile.dataRoot.status,
    authAvailability: discovery.capabilityAssessment.capabilities.find(
      (item) => item.key === "claude.auth",
    )?.availability ?? "UNKNOWN",
    authMethod: discovery.authMethod,
  },
  contract,
};
const target = resolve(outputPath(process.argv.slice(2)));
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(`Wrote privacy-safe Claude contract report to ${target}`);
