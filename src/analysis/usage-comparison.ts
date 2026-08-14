import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { ensureAxtoryDataDirectory } from "../core/data-directory.js";
import { writeAuditedJsonAtomically } from "../core/export.js";
import type { Availability } from "../core/model.js";
import { OUTPUT_POLICY_VERSION } from "../core/output.js";
import { generateUsageReport, type UsageReportOutput } from "./usage-report.js";

export const USAGE_COMPARISON_ANALYZER_VERSION = "usage-comparison/1";

export interface ComparisonWindowInput {
  since?: string;
  until?: string;
}

interface ComparedWindow {
  label: "EARLIER" | "LATER";
  since: string | null;
  until: string | null;
  availability: Availability;
  reason: string | null;
  sessions: number | null;
  messages: number | null;
  userMessages: number | null;
  assistantMessages: number | null;
  toolInvocations: number | null;
  activeUtcDays: number | null;
  sessionsWithToolsPercentage: number | null;
  assistantMessagesPerUserMessage: number | null;
  toolInvocationsPerAssistantMessage: number | null;
  toolCategories: readonly { category: string; count: number; percentage: number }[];
}

export interface UsageComparisonOutput {
  schemaVersion: "axtory.usage-comparison.v1";
  generatedAt: string;
  analyzerVersion: typeof USAGE_COMPARISON_ANALYZER_VERSION;
  derivation: "CALCULATED";
  scope: {
    sourceTypes: readonly string[];
    latestRevisionPerSourceObject: true;
    timeSemantics: "SOURCE_OCCURRED_AT";
  };
  windows: readonly [ComparedWindow, ComparedWindow];
  differences: {
    availability: Availability;
    reason: string | null;
    sessions: number | null;
    messages: number | null;
    toolInvocations: number | null;
    activeUtcDays: number | null;
    sessionsWithToolsPercentage: number | null;
    assistantMessagesPerUserMessage: number | null;
    toolInvocationsPerAssistantMessage: number | null;
  };
  toolCategoryShareDifference: readonly { category: string; earlier: number; later: number; difference: number }[];
  limitations: readonly string[];
}

function comparedWindow(label: ComparedWindow["label"], report: UsageReportOutput): ComparedWindow {
  return {
    label,
    since: report.scope.since,
    until: report.scope.until,
    availability: report.totals.availability,
    reason: report.totals.reason,
    sessions: report.totals.sessions,
    messages: report.totals.messages,
    userMessages: report.totals.userMessages,
    assistantMessages: report.totals.assistantMessages,
    toolInvocations: report.totals.toolInvocations,
    activeUtcDays: report.patterns.activeUtcDays,
    sessionsWithToolsPercentage: report.patterns.sessionsWithToolsPercentage,
    assistantMessagesPerUserMessage: report.patterns.assistantMessagesPerUserMessage,
    toolInvocationsPerAssistantMessage: report.patterns.toolInvocationsPerAssistantMessage,
    toolCategories: report.toolCategories,
  };
}

// A difference is only stated when both sides measured the value. A missing side stays null rather
// than becoming a delta against an assumed zero.
function difference(earlier: number | null, later: number | null): number | null {
  if (earlier === null || later === null) return null;
  return Number((later - earlier).toFixed(2));
}

function comparable(window: ComparedWindow): boolean {
  return window.availability === "AVAILABLE" || window.availability === "PARTIAL";
}

/**
 * The window labels are load-bearing: every difference is `later - earlier` and is rendered with a
 * sign against "Earlier"/"Later" headings. A later window that begins before the earlier one would
 * invert the direction of every reported change, so the ordering the labels claim is enforced here.
 * A later window nested inside a broader earlier one still begins no sooner and stays allowed.
 */
function assertWindowOrder(earlier: ComparisonWindowInput, later: ComparisonWindowInput): void {
  const start = (value: string | undefined): number => {
    if (value === undefined) return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error("comparison window bounds must be ISO-8601 timestamps");
    return parsed;
  };
  if (start(later.since) < start(earlier.since)) {
    throw new Error("the later comparison window must not begin before the earlier window");
  }
}

export async function compareUsageWindows(options: {
  dataDirectory: string;
  jsonOutputPath?: string;
  earlier: ComparisonWindowInput;
  later: ComparisonWindowInput;
  sourceTypes?: readonly string[];
  now?: () => Date;
  randomId?: () => string;
}): Promise<UsageComparisonOutput> {
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const sourceTypes = [...new Set(options.sourceTypes ?? [])].sort();
  assertWindowOrder(options.earlier, options.later);

  const windowOptions = (window: ComparisonWindowInput) => ({
    dataDirectory: options.dataDirectory,
    ...(window.since === undefined ? {} : { since: window.since }),
    ...(window.until === undefined ? {} : { until: window.until }),
    ...(sourceTypes.length === 0 ? {} : { sourceTypes }),
    now,
  });
  const earlierReport = await generateUsageReport({
    ...windowOptions(options.earlier), randomId: () => `comparison-earlier-${randomId()}`,
  });
  const laterReport = await generateUsageReport({
    ...windowOptions(options.later), randomId: () => `comparison-later-${randomId()}`,
  });

  const earlier = comparedWindow("EARLIER", earlierReport);
  const later = comparedWindow("LATER", laterReport);
  const bothMeasured = comparable(earlier) && comparable(later);
  const partial = earlier.availability === "PARTIAL" || later.availability === "PARTIAL";

  const categories = [...new Set([
    ...earlier.toolCategories.map((item) => item.category),
    ...later.toolCategories.map((item) => item.category),
  ])].sort();
  const shareOf = (window: ComparedWindow, category: string): number =>
    window.toolCategories.find((item) => item.category === category)?.percentage ?? 0;

  const output: UsageComparisonOutput = {
    schemaVersion: "axtory.usage-comparison.v1",
    generatedAt: now().toISOString(),
    analyzerVersion: USAGE_COMPARISON_ANALYZER_VERSION,
    derivation: "CALCULATED",
    scope: { sourceTypes, latestRevisionPerSourceObject: true, timeSemantics: "SOURCE_OCCURRED_AT" },
    windows: [earlier, later],
    differences: {
      availability: bothMeasured ? (partial ? "PARTIAL" : "AVAILABLE") : "UNKNOWN",
      reason: bothMeasured
        ? (partial ? "At least one window is partial, so its difference inherits that uncertainty." : null)
        : "A difference needs both windows measured; at least one window has no comparable usage.",
      sessions: bothMeasured ? difference(earlier.sessions, later.sessions) : null,
      messages: bothMeasured ? difference(earlier.messages, later.messages) : null,
      toolInvocations: bothMeasured ? difference(earlier.toolInvocations, later.toolInvocations) : null,
      activeUtcDays: bothMeasured ? difference(earlier.activeUtcDays, later.activeUtcDays) : null,
      sessionsWithToolsPercentage: bothMeasured
        ? difference(earlier.sessionsWithToolsPercentage, later.sessionsWithToolsPercentage) : null,
      assistantMessagesPerUserMessage: bothMeasured
        ? difference(earlier.assistantMessagesPerUserMessage, later.assistantMessagesPerUserMessage) : null,
      toolInvocationsPerAssistantMessage: bothMeasured
        ? difference(earlier.toolInvocationsPerAssistantMessage, later.toolInvocationsPerAssistantMessage) : null,
    },
    toolCategoryShareDifference: bothMeasured
      ? categories.map((category) => ({
        category, earlier: shareOf(earlier, category), later: shareOf(later, category),
        difference: Number((shareOf(later, category) - shareOf(earlier, category)).toFixed(2)),
      }))
      : [],
    limitations: [
      "Both windows are measured usage; the contrast between them is not an explanation of the change.",
      "A difference is a correlation in time and never establishes cause, contribution, or impact.",
      "Windows can hold different amounts of work, so compare rates before comparing totals.",
      "A session whose events straddle a boundary is counted in both windows it overlaps.",
      "Each window reads the latest retained revision per source object, not all historical revisions.",
      "Tool categories are privacy-safe groupings; custom extension names are not exported.",
    ],
  };

  if (options.jsonOutputPath !== undefined) {
    // The per-window reports deliberately run without a sink. The comparison itself is one audited
    // export whose STARTED row is durable before the final JSON path can appear.
    const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
    await writeAuditedJsonAtomically({
      databasePath: join(dataDirectory, "axtory.sqlite3"),
      jsonOutputPath: options.jsonOutputPath,
      output,
      audit: {
        id: `export_${randomId()}`,
        policyVersion: OUTPUT_POLICY_VERSION,
        recordCount: output.windows.length,
        classifications: ["LOCAL_METADATA"],
      },
      now: () => now().toISOString(),
    });
  }
  return output;
}

function windowLabel(window: ComparedWindow): string {
  return `${window.since ?? "beginning"} to ${window.until ?? "latest"}`;
}

function line(label: string, earlier: number | null, later: number | null, delta: number | null): string {
  const show = (value: number | null): string => value === null ? "UNKNOWN" : String(value);
  const sign = delta === null ? "" : delta > 0 ? "+" : "";
  return `  ${label}: ${show(earlier)} -> ${show(later)}` +
    (delta === null ? " (difference UNKNOWN)" : ` (${sign}${delta})`);
}

export function renderUsageComparison(output: UsageComparisonOutput): string {
  const [earlier, later] = output.windows;
  const lines = [
    "AXtory usage window comparison",
    `Earlier window: ${windowLabel(earlier)} [${earlier.availability}]`,
    `Later window: ${windowLabel(later)} [${later.availability}]`,
    `Differences: ${output.differences.availability}` +
      (output.differences.reason === null ? "" : ` (${output.differences.reason})`),
    line("Sessions", earlier.sessions, later.sessions, output.differences.sessions),
    line("Messages", earlier.messages, later.messages, output.differences.messages),
    line("Tool invocations", earlier.toolInvocations, later.toolInvocations, output.differences.toolInvocations),
    line("Active UTC days", earlier.activeUtcDays, later.activeUtcDays, output.differences.activeUtcDays),
    line("Sessions using tools %", earlier.sessionsWithToolsPercentage, later.sessionsWithToolsPercentage,
      output.differences.sessionsWithToolsPercentage),
    line("Assistant/user messages", earlier.assistantMessagesPerUserMessage,
      later.assistantMessagesPerUserMessage, output.differences.assistantMessagesPerUserMessage),
    line("Tools/assistant message", earlier.toolInvocationsPerAssistantMessage,
      later.toolInvocationsPerAssistantMessage, output.differences.toolInvocationsPerAssistantMessage),
  ];
  if (output.toolCategoryShareDifference.length > 0) {
    lines.push("Tool category share (%):");
    for (const item of output.toolCategoryShareDifference) {
      const sign = item.difference > 0 ? "+" : "";
      lines.push(`  ${item.category}: ${item.earlier} -> ${item.later} (${sign}${item.difference})`);
    }
  }
  lines.push("A measured difference between windows is not evidence that the agent caused it.");
  return `${lines.join("\n")}\n`;
}
