#!/usr/bin/env node
import { resolve } from "node:path";

import { collectClaudeHistory, renderClaudeCollection } from "./connectors/claude/collector.js";
import { discoverClaude } from "./connectors/claude/discovery.js";
import { loadClaudeHistoryApi } from "./connectors/claude/history-api.js";
import { renderConsole } from "./core/output.js";
import { runWalkingSkeleton } from "./core/pipeline.js";
import { purgeAxtoryDataDirectory } from "./core/data-directory.js";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "purge") {
    const dataDirectory = option(args, "--data-dir");
    const confirmation = option(args, "--confirm");
    if (!dataDirectory || !confirmation) {
      throw new Error("purge requires --data-dir and --confirm PURGE_ALL");
    }
    await purgeAxtoryDataDirectory(resolve(dataDirectory), confirmation);
    process.stdout.write("AXtory data directory purged. This operation is not recoverable.\n");
    return;
  }
  if (command === "collect-claude") {
    const dataDirectory = option(args, "--data-dir");
    const jsonOutput = option(args, "--json-out");
    if (!dataDirectory || !jsonOutput) {
      throw new Error("collect-claude requires --data-dir and --json-out");
    }
    const pageSizeValue = option(args, "--page-size");
    const maxPagesValue = option(args, "--max-pages");
    const parsePositive = (value: string, name: string): number => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
      return parsed;
    };
    const discovery = await discoverClaude();
    const api = await loadClaudeHistoryApi();
    const output = await collectClaudeHistory(api, discovery, {
      dataDirectory: resolve(dataDirectory),
      jsonOutputPath: resolve(jsonOutput),
      ...(option(args, "--project-dir") ? { projectDirectory: resolve(option(args, "--project-dir")!) } : {}),
      ...(pageSizeValue !== undefined ? { pageSize: parsePositive(pageSizeValue, "--page-size") } : {}),
      ...(maxPagesValue !== undefined ? { maxPages: parsePositive(maxPagesValue, "--max-pages") } : {}),
    });
    process.stdout.write(renderClaudeCollection(output));
    return;
  }
  if (command !== "collect-fixture") {
    throw new Error("usage: axtory <collect-fixture|collect-claude|purge> [options]");
  }
  const fixture = option(args, "--fixture");
  const dataDirectory = option(args, "--data-dir");
  const jsonOutput = option(args, "--json-out");
  if (!fixture || !dataDirectory || !jsonOutput) {
    throw new Error("collect-fixture requires --fixture, --data-dir, and --json-out");
  }
  const result = await runWalkingSkeleton({
    fixturePath: resolve(fixture),
    dataDirectory: resolve(dataDirectory),
    jsonOutputPath: resolve(jsonOutput),
  });
  process.stdout.write(renderConsole(result.output));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`AXtory failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
