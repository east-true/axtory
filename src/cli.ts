#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { collectClaudeHistory, renderClaudeCollection } from "./connectors/claude/collector.js";
import { discoverClaude } from "./connectors/claude/discovery.js";
import { loadClaudeHistoryApi } from "./connectors/claude/history-api.js";
import { renderConsole } from "./core/output.js";
import { runWalkingSkeleton } from "./core/pipeline.js";
import { purgeAxtoryDataDirectory } from "./core/data-directory.js";
import { applyRetention, executeSelectiveDeletion, type SelectiveDeletionMode } from "./core/deletion.js";
import { DEFAULT_LOCAL_COLLECTION_POLICY } from "./core/policy.js";
import { VERIFICATION_STATUSES, VERIFICATION_TYPES } from "./core/records.js";
import { ensureAxtoryDataDirectory } from "./core/data-directory.js";
import { AxtoryDatabase } from "./core/storage.js";
import { runRuleSemanticAnalysis } from "./analysis/semantic-pipeline.js";
import { collectLocalGit } from "./connectors/git/collector.js";
import { startLiveReceiver } from "./live/receiver.js";
import {
  applyClaudeLiveConfiguration,
  planClaudeLiveConfiguration,
  rollbackClaudeLiveConfiguration,
} from "./live/claude-configuration.js";
import { ingestLiveSpool } from "./live/ingestion.js";
import { CodexAppServerClient } from "./connectors/codex/app-server.js";
import { collectCodexHistory, renderCodexCollection } from "./connectors/codex/collector.js";
import { assertSanitizedCodexReport, runCodexContractSpike } from "./connectors/codex/contract-spike.js";
import { discoverCodex } from "./connectors/codex/discovery.js";
import { createCodexHomeSnapshot } from "./connectors/codex/snapshot.js";
import { writeJsonAtomically } from "./core/output.js";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function options(args: readonly string[], name: string): string[] {
  return args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]!] : []);
}

async function openDataDatabase(path: string): Promise<AxtoryDatabase> {
  const dataDirectory = await ensureAxtoryDataDirectory(resolve(path));
  return new AxtoryDatabase(join(dataDirectory, "axtory.sqlite3"));
}

function availableValue(value: { status: string; value?: string }, label: string): string {
  if (value.status !== "AVAILABLE" || typeof value.value !== "string") {
    throw new Error(`${label} is unavailable`);
  }
  return value.value;
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "spike-codex" || command === "collect-codex") {
    const jsonOutput = option(args, "--json-out");
    if (!jsonOutput) throw new Error(`${command} requires --json-out`);
    const pageSizeValue = option(args, "--page-size");
    const maxPagesValue = option(args, "--max-pages");
    const parsePositive = (value: string, name: string): number => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
      return parsed;
    };
    const discovery = await discoverCodex();
    const executablePath = availableValue(discovery.sourceProfile.executablePath, "Codex executable");
    const codexHome = availableValue(discovery.sourceProfile.dataRoot, "Codex data root");
    const snapshot = await createCodexHomeSnapshot(codexHome);
    const client = new CodexAppServerClient({ executablePath, codexHome: snapshot.path });
    try {
      if (command === "spike-codex") {
        const threadLimitValue = option(args, "--thread-limit");
        const report = await runCodexContractSpike(client, {
          ...(pageSizeValue !== undefined ? { pageSize: parsePositive(pageSizeValue, "--page-size") } : {}),
          ...(maxPagesValue !== undefined ? { maxPages: parsePositive(maxPagesValue, "--max-pages") } : {}),
          ...(threadLimitValue !== undefined
            ? { threadLimit: parsePositive(threadLimitValue, "--thread-limit") }
            : {}),
        });
        assertSanitizedCodexReport(report);
        await writeJsonAtomically(resolve(jsonOutput), report);
        process.stdout.write(`AXtory Codex contract spike: ${report.threadCount} threads, ` +
          `${report.fullTurnViewCount + report.partialTurnViewCount} inspected turns [${report.coverage}].\n`);
      } else {
        const dataDirectory = option(args, "--data-dir");
        if (!dataDirectory) throw new Error("collect-codex requires --data-dir and --json-out");
        const output = await collectCodexHistory(client, discovery, {
          dataDirectory: resolve(dataDirectory),
          jsonOutputPath: resolve(jsonOutput),
          ...(pageSizeValue !== undefined ? { pageSize: parsePositive(pageSizeValue, "--page-size") } : {}),
          ...(maxPagesValue !== undefined ? { maxPages: parsePositive(maxPagesValue, "--max-pages") } : {}),
        });
        process.stdout.write(renderCodexCollection(output));
      }
    } finally {
      await client.close();
      await snapshot.dispose();
    }
    return;
  }
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
  if (command === "list") {
    const dataDirectory = option(args, "--data-dir");
    if (!dataDirectory) throw new Error("list requires --data-dir");
    const database = await openDataDatabase(dataDirectory);
    try {
      process.stdout.write(`${JSON.stringify(database.inventory(), null, 2)}\n`);
    } finally {
      database.close();
    }
    return;
  }
  if (command === "delete") {
    const dataDirectory = option(args, "--data-dir");
    const mode = option(args, "--mode") as SelectiveDeletionMode | undefined;
    const confirmation = option(args, "--confirm");
    if (!dataDirectory || !mode || !confirmation ||
      !["DELETE_RAW_ONLY", "DELETE_RAW_AND_DERIVED", "DELETE_SOURCE_SESSION"].includes(mode)) {
      throw new Error("delete requires --data-dir, a supported --mode, its --confirm value, and a target");
    }
    const sourceObjectId = option(args, "--source-object-id");
    const revisionIds = options(args, "--revision-id");
    const result = await executeSelectiveDeletion({
      dataDirectory: resolve(dataDirectory), mode, confirmation,
      target: mode === "DELETE_SOURCE_SESSION"
        ? { ...(sourceObjectId ? { sourceObjectId } : {}) }
        : { revisionIds },
    });
    process.stdout.write(`AXtory ${mode} completed: ${result.rawObservationsDeleted} raw observations, ` +
      `${result.normalizedObservationsDeleted} normalized observations, ${result.analysisRunsDeleted} analysis runs, ` +
      `${result.blobsDeleted} blobs and ${result.spoolEntriesDeleted} pending live events deleted.\n`);
    return;
  }
  if (command === "retain") {
    const dataDirectory = option(args, "--data-dir");
    const classification = option(args, "--classification");
    const daysValue = option(args, "--days");
    const days = Number(daysValue);
    if (!dataDirectory || !classification || daysValue === undefined || !Number.isInteger(days) || days < 0 ||
      !(classification in DEFAULT_LOCAL_COLLECTION_POLICY.classifications)) {
      throw new Error("retain requires --data-dir, a known --classification, and non-negative integer --days");
    }
    const policy = {
      ...DEFAULT_LOCAL_COLLECTION_POLICY,
      version: `local-retention/${classification.toLowerCase()}-${days}d`,
      classifications: {
        ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications,
        [classification]: {
          ...DEFAULT_LOCAL_COLLECTION_POLICY.classifications[
            classification as keyof typeof DEFAULT_LOCAL_COLLECTION_POLICY.classifications
          ],
          retentionDays: days,
        },
      },
    };
    const result = await applyRetention({ dataDirectory: resolve(dataDirectory), policy });
    process.stdout.write(`AXtory retention completed: ${result.rawObservationsDeleted} raw observations and ` +
      `${result.blobsDeleted} blobs deleted.\n`);
    return;
  }
  if (command === "annotate") {
    const dataDirectory = option(args, "--data-dir");
    const targetType = option(args, "--target-type");
    const targetId = option(args, "--target-id");
    const assertion = option(args, "--assertion");
    if (!dataDirectory || !targetId || !assertion ||
      (targetType !== "SOURCE_REVISION" && targetType !== "ANALYSIS_RECORD")) {
      throw new Error("annotate requires --data-dir, --target-type, --target-id, and --assertion");
    }
    const database = await openDataDatabase(dataDirectory);
    try {
      database.insertUserAnnotation({
        id: `annotation_${randomUUID()}`, targetType, targetId, assertion, createdAt: new Date().toISOString(),
      });
    } finally {
      database.close();
    }
    process.stdout.write("AXtory user annotation recorded. It does not overwrite source or analysis facts.\n");
    return;
  }
  if (command === "verify") {
    const dataDirectory = option(args, "--data-dir");
    const analysisRecordId = option(args, "--analysis-record-id");
    const verificationType = option(args, "--type");
    const status = option(args, "--status");
    if (!dataDirectory || !analysisRecordId ||
      !VERIFICATION_TYPES.includes(verificationType as typeof VERIFICATION_TYPES[number]) ||
      !VERIFICATION_STATUSES.includes(status as typeof VERIFICATION_STATUSES[number])) {
      throw new Error("verify requires --data-dir, --analysis-record-id, supported --type, and supported --status");
    }
    const database = await openDataDatabase(dataDirectory);
    try {
      database.insertVerificationRecord({
        id: `verification_${randomUUID()}`, analysisRecordId,
        verificationType: verificationType as typeof VERIFICATION_TYPES[number],
        status: status as typeof VERIFICATION_STATUSES[number], provenance: "USER_PROVIDED",
        evidenceIds: options(args, "--evidence-id"), note: option(args, "--note") ?? null,
        verifiedAt: new Date().toISOString(),
      });
    } finally {
      database.close();
    }
    process.stdout.write("AXtory verification recorded separately from the analysis result.\n");
    return;
  }
  if (command === "analyze-rule") {
    const dataDirectory = option(args, "--data-dir");
    const revisionId = option(args, "--revision-id");
    if (!dataDirectory || !revisionId) {
      throw new Error("analyze-rule requires --data-dir, --revision-id, and --allow-conversation-content");
    }
    const summary = await runRuleSemanticAnalysis({
      dataDirectory: resolve(dataDirectory), revisionId,
      allowConversationContent: args.includes("--allow-conversation-content"),
    });
    process.stdout.write(`AXtory semantic analysis [INFERRED]: ${summary.assertionsFound} unverified assertions ` +
      `from ${summary.documentsAnalyzed} assistant messages.\n${summary.limitation}\n`);
    return;
  }
  if (command === "collect-git") {
    const repositoryDirectory = option(args, "--repo-dir");
    const dataDirectory = option(args, "--data-dir");
    const jsonOutputPath = option(args, "--json-out");
    if (!repositoryDirectory || !dataDirectory || !jsonOutputPath) {
      throw new Error("collect-git requires --repo-dir, --data-dir, and --json-out");
    }
    const maximumCommitsValue = option(args, "--max-commits");
    const maximumCommits = maximumCommitsValue === undefined ? undefined : Number(maximumCommitsValue);
    if (maximumCommits !== undefined && (!Number.isInteger(maximumCommits) || maximumCommits < 1)) {
      throw new Error("--max-commits must be a positive integer");
    }
    const output = await collectLocalGit({
      repositoryDirectory: resolve(repositoryDirectory), dataDirectory: resolve(dataDirectory),
      jsonOutputPath: resolve(jsonOutputPath),
      ...(option(args, "--session-revision-id")
        ? { sessionRevisionId: option(args, "--session-revision-id")! }
        : {}),
      ...(maximumCommits !== undefined ? { maximumCommits } : {}),
    });
    process.stdout.write(`AXtory Local Git: ${output.commitsReturned} commits, ` +
      `${output.correlations} inferred temporal correlations.\n`);
    return;
  }
  if (command === "ingest-live") {
    const dataDirectory = option(args, "--data-dir");
    const jsonOutputPath = option(args, "--json-out");
    if (!dataDirectory || !jsonOutputPath) throw new Error("ingest-live requires --data-dir and --json-out");
    const summary = await ingestLiveSpool({
      dataDirectory: resolve(dataDirectory), jsonOutputPath: resolve(jsonOutputPath),
    });
    process.stdout.write(`AXtory live ingestion: ${summary.ingested} ingested, ${summary.duplicates} duplicates, ` +
      `${summary.failed} failed, ${summary.telemetryFacts} telemetry facts.\n`);
    return;
  }
  if (command === "rollback-live") {
    const settingsPath = option(args, "--settings");
    const backupPath = option(args, "--backup");
    const confirmation = option(args, "--confirm");
    if (!settingsPath || !backupPath || !confirmation) {
      throw new Error("rollback-live requires --settings, --backup, and --confirm ROLLBACK_CLAUDE_LIVE_CONFIG");
    }
    await rollbackClaudeLiveConfiguration({
      settingsPath: resolve(settingsPath), backupPath: resolve(backupPath), confirmation,
    });
    process.stdout.write("AXtory restored the exact pre-live Claude settings backup.\n");
    return;
  }
  if (command === "plan-live") {
    const settingsPath = option(args, "--settings");
    const enableHooks = args.includes("--enable-hooks");
    const enableOtel = args.includes("--enable-otel");
    if (!settingsPath || (!enableHooks && !enableOtel)) {
      throw new Error("plan-live requires --settings and at least one live channel");
    }
    const plan = await planClaudeLiveConfiguration({
      settingsPath: resolve(settingsPath), enableHooks, enableOtel,
    });
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (command === "serve-live") {
    const dataDirectory = option(args, "--data-dir");
    const settingsPath = option(args, "--settings");
    const confirmation = option(args, "--confirm");
    const enableHooks = args.includes("--enable-hooks");
    const enableOtel = args.includes("--enable-otel");
    const portValue = option(args, "--port");
    const port = portValue === undefined ? undefined : Number(portValue);
    if (!dataDirectory || !settingsPath || !confirmation || (!enableHooks && !enableOtel) ||
      (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535))) {
      throw new Error("serve-live requires --data-dir, --settings, a live channel, and explicit confirmation");
    }
    const receiver = await startLiveReceiver({
      dataDirectory: resolve(dataDirectory), ...(port !== undefined ? { port } : {}),
    });
    try {
      const applied = await applyClaudeLiveConfiguration({
        settingsPath: resolve(settingsPath), endpoint: receiver.endpoint, token: receiver.token,
        enableHooks, enableOtel, confirmation,
      });
      process.stdout.write(`AXtory live receiver is listening on loopback. Settings backup: ${applied.backupPath}\n` +
        "Press Ctrl+C to stop. Restore settings with rollback-live when live collection is no longer wanted.\n");
      await new Promise<void>((resolvePromise) => {
        const stop = () => resolvePromise();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
    } finally {
      await receiver.stop();
    }
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
    throw new Error("usage: axtory <collect-fixture|collect-claude|collect-codex|spike-codex|collect-git|analyze-rule|plan-live|serve-live|ingest-live|rollback-live|list|delete|retain|annotate|verify|purge> [options]");
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
