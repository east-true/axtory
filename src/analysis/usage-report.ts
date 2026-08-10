import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { stableId } from "../core/canonical-json.js";
import { ensureAxtoryDataDirectory } from "../core/data-directory.js";
import type { Availability } from "../core/model.js";
import { OUTPUT_POLICY_VERSION, writeJsonAtomically } from "../core/output.js";
import {
  VERIFICATION_STATUSES,
  VERIFICATION_TYPES,
  type AnalysisRecord,
  type NormalizedObservation,
} from "../core/records.js";
import { AxtoryDatabase } from "../core/storage.js";
import { projectSession } from "../projections/session.js";
import { analyzeOtelFacts } from "./otel-analyzer.js";
import { RULE_SEMANTIC_ANALYZER_VERSION } from "./semantic-analyzer.js";
import { runRuleSemanticAnalysis } from "./semantic-pipeline.js";
import { OTEL_METRIC_CATALOG, USAGE_METRIC_CATALOG, type MetricDefinition } from "./metric-catalog.js";

export const USAGE_REPORT_ANALYZER_VERSION = "usage-report/2";
const SEMANTIC_REVISION_LIMIT = 100;

type Distribution = {
  minimum: number | null;
  median: number | null;
  p90: number | null;
  maximum: number | null;
  mean: number | null;
};

export interface UsageReportOutput {
  schemaVersion: "axtory.usage-report.v2";
  generatedAt: string;
  analysisRunId: string;
  analyzerVersion: typeof USAGE_REPORT_ANALYZER_VERSION;
  derivation: "CALCULATED";
  scope: {
    since: string | null;
    until: string | null;
    sourceTypes: readonly string[];
    latestRevisionPerSourceObject: true;
    timeSemantics: "SOURCE_OCCURRED_AT";
  };
  totals: {
    availability: Availability;
    reason: string | null;
    sessions: number | null;
    messages: number | null;
    userMessages: number | null;
    assistantMessages: number | null;
    toolInvocations: number | null;
    firstActivityAt: string | null;
    lastActivityAt: string | null;
  };
  sessionDistribution: {
    messagesPerSession: Distribution;
    toolsPerSession: Distribution;
  };
  patterns: {
    activeUtcDays: number | null;
    sessionsWithTools: number | null;
    sessionsWithToolsPercentage: number | null;
    assistantMessagesPerUserMessage: number | null;
    toolInvocationsPerAssistantMessage: number | null;
  };
  coverage: {
    completeSessions: number;
    partialSessions: number;
    unknownSessions: number;
    completedCollectionHeads: number;
    legacyFallbackHeads: number;
    excludedUndatedObservations: number;
    timelineAvailability: Availability;
    timelineReason: string | null;
  };
  evidence: {
    status: AnalysisRecord["evidenceStatus"];
    revisionsWithRaw: number;
    revisionsWithoutRaw: number;
    reason: string | null;
  };
  bySource: readonly {
    sourceType: string;
    availability: Availability;
    sessions: number;
    messages: number;
    toolInvocations: number;
  }[];
  toolCategories: readonly { category: string; count: number; percentage: number }[];
  timelineByUtcDay: readonly {
    date: string;
    sessionsStarted: number;
    messages: number;
    toolInvocations: number;
  }[];
  semantics: {
    derivation: "INFERRED";
    availability: Availability;
    reason: string | null;
    candidateRevisions: number;
    eligibleRevisions: number;
    analyzedRevisions: number;
    assertions: number | null;
    categories: readonly { category: string; count: number }[];
  };
  telemetry: {
    availability: Availability;
    reason: string | null;
    excludedUndatedObservations: number;
    categories: {
      tokens: Availability;
      model: Availability;
      cost: Availability;
      latency: Availability;
    };
    facts: readonly {
      channel: "EVENT" | "METRIC";
      key: string;
      value: number;
      unit: string | null;
      occurrences: number;
      type: string | null;
      model: string | null;
      evidenceStatus: AnalysisRecord["evidenceStatus"];
    }[];
  };
  verification: {
    availability: Availability;
    reason: string | null;
    records: number | null;
    byTypeAndStatus: readonly {
      verificationType: string;
      status: string;
      count: number;
    }[];
    analysisEvidence: {
      present: number;
      evidenceRemoved: number;
      invalidated: number;
    };
  };
  annotations: {
    availability: Availability;
    reason: string | null;
    records: number | null;
    sourceRevisionRecords: number;
    analysisRecordRecords: number;
  };
  limitations: readonly string[];
}

interface SessionInput {
  sourceType: string;
  revisionId: string;
  observations: readonly NormalizedObservation[];
  session: NormalizedObservation;
  messages: readonly NormalizedObservation[];
  tools: readonly NormalizedObservation[];
  coverage: ReturnType<typeof projectSession>["messageCoverage"];
  headSelection: "COMPLETED_COLLECTION" | "LEGACY_REVISION_ORDER";
  rawRetained: boolean;
}

interface SelectedSession extends SessionInput {
  selectedMessages: readonly NormalizedObservation[];
  selectedTools: readonly NormalizedObservation[];
}

const SAFE_TOOL_CATEGORIES = new Map<string, string>([
  ["Bash", "shell"], ["commandExecution", "shell"],
  ["Read", "file-read"], ["Glob", "file-read"], ["Grep", "file-read"], ["imageView", "file-read"],
  ["Write", "file-change"], ["Edit", "file-change"], ["NotebookEdit", "file-change"],
  ["fileChange", "file-change"],
  ["Task", "agent-coordination"], ["collabAgentToolCall", "agent-coordination"],
  ["subAgentActivity", "agent-coordination"],
  ["WebSearch", "web"], ["WebFetch", "web"], ["webSearch", "web"],
  ["TodoWrite", "planning"], ["AskUserQuestion", "planning"], ["EnterPlanMode", "planning"],
  ["ExitPlanMode", "planning"],
  ["Skill", "extension"], ["mcpToolCall", "extension"], ["dynamicToolCall", "extension"],
  ["sleep", "wait"], ["imageGeneration", "image-generation"], ["tool", "other"],
]);

function parseBoundary(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${name} must be an ISO-8601 timestamp`);
  return new Date(milliseconds).toISOString();
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { minimum: null, median: null, p90: null, maximum: null, mean: null };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    minimum: sorted[0]!, median: Number(median.toFixed(2)),
    p90: sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)]!, maximum: sorted.at(-1)!,
    mean: Number(mean.toFixed(2)),
  };
}

function safeToolCategory(observation: NormalizedObservation): string {
  const value = typeof observation.payload.toolName === "string"
    ? observation.payload.toolName
    : typeof observation.payload.toolType === "string"
      ? observation.payload.toolType
      : "UNKNOWN";
  if (value.startsWith("mcp:") || value.startsWith("dynamic:") || value.startsWith("mcp__")) {
    return "extension";
  }
  return SAFE_TOOL_CATEGORIES.get(value) ?? "other";
}

function inWindow(timestamp: string | null, since: string | null, until: string | null): boolean {
  if (!timestamp) return since === null && until === null;
  return (since === null || timestamp >= since) && (until === null || timestamp < until);
}

function utcDay(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function safeSourceType(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value : "UNKNOWN_SOURCE";
}

function safeTelemetryLabel(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(value)
    ? value
    : null;
}

function loadSessionInputs(database: AxtoryDatabase, sourceTypes: ReadonlySet<string>): SessionInput[] {
  return database.latestRevisions().flatMap((revision): SessionInput[] => {
    if (sourceTypes.size > 0 && !sourceTypes.has(revision.sourceType)) return [];
    const observations = database.observationsForRevision(revision.revisionId);
    const session = observations.find((item) => item.stableKey === "session" && item.kind === "SNAPSHOT");
    if (!session) return [];
    const projection = projectSession(observations);
    return [{
      sourceType: safeSourceType(revision.sourceType), revisionId: revision.revisionId, observations, session,
      messages: observations.filter((item) => item.kind === "CONTENT"),
      tools: observations.filter((item) => item.stableKey.startsWith("tool-occurrence:")),
      coverage: projection.messageCoverage,
      headSelection: revision.headSelection,
      rawRetained: database.rawObservationForRevision(revision.revisionId) !== null,
    }];
  });
}

interface TelemetryInput {
  revisionId: string;
  observations: readonly NormalizedObservation[];
  rawRetained: boolean;
}

function loadTelemetryInputs(database: AxtoryDatabase, sourceTypes: ReadonlySet<string>): TelemetryInput[] {
  if (sourceTypes.size > 0 && !sourceTypes.has("CLAUDE_CODE")) return [];
  return database.latestRevisions().flatMap((revision): TelemetryInput[] => {
    if (revision.sourceType !== "CLAUDE_OTEL_LOGS" && revision.sourceType !== "CLAUDE_OTEL_METRICS") return [];
    const observations = database.observationsForRevision(revision.revisionId)
      .filter((item) => item.stableKey.startsWith("otel-"));
    if (observations.length === 0) return [];
    return [{
      revisionId: revision.revisionId,
      observations,
      rawRetained: database.rawObservationForRevision(revision.revisionId) !== null,
    }];
  });
}

function selectedSessions(
  inputs: readonly SessionInput[],
  since: string | null,
  until: string | null,
): { sessions: SelectedSession[]; excludedUndatedObservations: number } {
  const bounded = since !== null || until !== null;
  let excludedUndatedObservations = 0;
  const sessions = inputs.flatMap((input): SelectedSession[] => {
    const selectedMessages = input.messages.filter((item) => inWindow(item.occurredAt, since, until));
    const selectedTools = input.tools.filter((item) => inWindow(item.occurredAt, since, until));
    if (bounded) {
      excludedUndatedObservations += input.messages.filter((item) => item.occurredAt === null).length;
      excludedUndatedObservations += input.tools.filter((item) => item.occurredAt === null).length;
    }
    const sessionInWindow = inWindow(input.session.occurredAt, since, until);
    if (!sessionInWindow && selectedMessages.length === 0 && selectedTools.length === 0) return [];
    return [{ ...input, selectedMessages, selectedTools }];
  });
  return { sessions, excludedUndatedObservations };
}

function supportsRuleSemantics(input: SessionInput): boolean {
  if (input.sourceType === "CLAUDE_CODE" || input.sourceType === "CODEX" || input.sourceType === "FIXTURE") {
    return true;
  }
  return input.sourceType === "ADDITIONAL_AI_OPENCODE";
}

function totalsAvailability(
  scopedSessionCount: number,
  selected: readonly SelectedSession[],
  bounded: boolean,
  excludedUndatedObservations: number,
): { availability: Availability; reason: string | null } {
  if (scopedSessionCount === 0) {
    return { availability: "SOURCE_UNAVAILABLE", reason: "No collected session source matches the report scope." };
  }
  const incomplete = selected.some((item) => item.coverage !== "COMPLETE_FOR_RETURNED_VIEW");
  const legacyFallback = selected.some((item) => item.headSelection === "LEGACY_REVISION_ORDER");
  const evidenceRemoved = selected.some((item) => !item.rawRetained);
  if (incomplete || legacyFallback || evidenceRemoved || (bounded && excludedUndatedObservations > 0)) {
    const reasons = [
      ...(incomplete ? ["One or more latest session views have partial or unknown coverage."] : []),
      ...(legacyFallback ? ["One or more legacy sources lack a completed-collection head relation."] : []),
      ...(evidenceRemoved ? ["Raw evidence was removed for one or more selected revisions."] : []),
      ...(bounded && excludedUndatedObservations > 0
        ? ["Undated observations were excluded from the bounded time window."] : []),
    ];
    return { availability: "PARTIAL", reason: reasons.join(" ") };
  }
  return { availability: "AVAILABLE", reason: null };
}

function reportMetric(
  analysisRunId: string,
  definition: MetricDefinition,
  value: number | null,
  availability: Availability,
  reason: string | null,
  evidenceIds: readonly string[],
  evidenceStatus: AnalysisRecord["evidenceStatus"],
): AnalysisRecord {
  return {
    id: stableId("analysis", { analysisRunId, key: definition.key }), analysisRunId, key: definition.key,
    recordType: "METRIC", derivation: definition.derivation, value, unit: definition.unit, availability, reason,
    evidenceIds, evidenceStatus,
  };
}

const OTEL_DEFINITION_KEYS = Object.keys(OTEL_METRIC_CATALOG)
  .sort((left, right) => right.length - left.length);

function otelDefinitionKey(occurrenceKey: string): string | null {
  return OTEL_DEFINITION_KEYS.find((key) => occurrenceKey.startsWith(`${key}.occurrence.`)) ?? null;
}

function telemetryCategory(key: string): "tokens" | "model" | "cost" | "latency" | null {
  if (key.includes(".usage.") || key.includes(".token.")) return "tokens";
  if (key.includes(".model.")) return "model";
  if (key.includes(".cost.")) return "cost";
  if (key.includes(".latency.")) return "latency";
  return null;
}

export async function generateUsageReport(options: {
  dataDirectory: string;
  jsonOutputPath: string;
  since?: string;
  until?: string;
  sourceTypes?: readonly string[];
  allowConversationContent?: boolean;
  now?: () => Date;
  randomId?: () => string;
}): Promise<UsageReportOutput> {
  const since = parseBoundary(options.since, "--since");
  const until = parseBoundary(options.until, "--until");
  if (since && until && since >= until) throw new Error("--since must be earlier than --until");
  const sourceTypes = [...new Set(options.sourceTypes ?? [])].sort();
  const sourceTypeSet = new Set(sourceTypes);
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const dataDirectory = await ensureAxtoryDataDirectory(options.dataDirectory);
  const databasePath = join(dataDirectory, "axtory.sqlite3");

  let database = new AxtoryDatabase(databasePath);
  let inputs = loadSessionInputs(database, sourceTypeSet);
  let selected = selectedSessions(inputs, since, until);
  const semanticInputs = selected.sessions.filter(supportsRuleSemantics);
  const eligibleSemanticInputs = semanticInputs.filter((input) => {
    const raw = database.rawObservationForRevision(input.revisionId);
    return raw?.dataClassification === "CONVERSATION_CONTENT";
  });
  if (options.allowConversationContent) {
    if (eligibleSemanticInputs.length > SEMANTIC_REVISION_LIMIT) {
      throw new Error("opt-in usage semantic analysis is limited to 100 revisions; narrow --source or the time window");
    }
    const missing = eligibleSemanticInputs.filter((input) =>
      database.completedAnalysisForExactInputs(
        "RULE_SEMANTIC_ANALYZER", RULE_SEMANTIC_ANALYZER_VERSION, [input.revisionId],
      ) === null);
    database.close();
    for (const input of missing) {
      await runRuleSemanticAnalysis({
        dataDirectory, revisionId: input.revisionId, allowConversationContent: true,
        now, randomId: () => `usage-semantic-${randomId()}`,
      });
    }
    database = new AxtoryDatabase(databasePath);
    inputs = loadSessionInputs(database, sourceTypeSet);
    selected = selectedSessions(inputs, since, until);
  }

  const analysisRunId = `analysis_${randomId()}`;
  const generatedAt = now().toISOString();
  const bounded = since !== null || until !== null;
  const availability = totalsAvailability(
    inputs.length, selected.sessions, bounded, selected.excludedUndatedObservations,
  );
  const hasSource = inputs.length > 0;
  const sessions = selected.sessions;
  const messages = sessions.flatMap((item) => item.selectedMessages);
  const tools = sessions.flatMap((item) => item.selectedTools);
  const telemetryInputs = loadTelemetryInputs(database, sourceTypeSet);
  const telemetrySelectedInputs = telemetryInputs.flatMap((input): TelemetryInput[] =>
    input.observations.some((item) => inWindow(item.occurredAt, since, until)) ? [input] : []);
  const telemetryObservations = telemetryInputs.flatMap((input) => input.observations)
    .filter((item) => inWindow(item.occurredAt, since, until));
  const telemetryExcludedUndated = bounded
    ? telemetryInputs.flatMap((input) => input.observations).filter((item) => item.occurredAt === null).length
    : 0;
  const selectedSessionStarts = sessions
    .map((item) => item.session)
    .filter((item) => inWindow(item.occurredAt, since, until));
  const undatedSessionStarts = sessions.filter((item) => item.session.occurredAt === null).length;
  const sessionEvidence = sessions.map((item) => item.session.id);
  const messageEvidence = messages.map((item) => item.id);
  const toolEvidence = tools.map((item) => item.id);
  const telemetryEvidence = telemetryObservations.map((item) => item.id);
  const activities = [...selectedSessionStarts, ...messages, ...tools]
    .flatMap((item) => item.occurredAt ? [item.occurredAt] : []).sort();
  const completeSessions = sessions.filter((item) => item.coverage === "COMPLETE_FOR_RETURNED_VIEW").length;
  const unknownSessions = sessions.filter((item) => item.coverage === "UNKNOWN").length;
  const partialSessions = sessions.length - completeSessions - unknownSessions;
  const completedCollectionHeads = sessions
    .filter((item) => item.headSelection === "COMPLETED_COLLECTION").length;
  const legacyFallbackHeads = sessions.length - completedCollectionHeads;
  const evidenceInputs = [
    ...sessions.map((item) => ({ revisionId: item.revisionId, rawRetained: item.rawRetained })),
    ...telemetrySelectedInputs.map((item) => ({ revisionId: item.revisionId, rawRetained: item.rawRetained })),
  ];
  const evidenceByRevision = new Map(evidenceInputs.map((item) => [item.revisionId, item.rawRetained]));
  const revisionsWithRaw = [...evidenceByRevision.values()].filter(Boolean).length;
  const revisionsWithoutRaw = evidenceByRevision.size - revisionsWithRaw;
  const reportEvidenceStatus: AnalysisRecord["evidenceStatus"] = revisionsWithoutRaw > 0
    ? "EVIDENCE_REMOVED"
    : "PRESENT";
  const undatedForTimeline = undatedSessionStarts + [...messages, ...tools]
    .filter((item) => item.occurredAt === null).length;
  const timelineAvailability: Availability = !hasSource
    ? "SOURCE_UNAVAILABLE"
    : availability.availability === "PARTIAL" || undatedForTimeline > 0
      ? "PARTIAL"
      : "AVAILABLE";
  const timelineReason = !hasSource
    ? availability.reason
    : undatedForTimeline > 0
      ? `${undatedForTimeline} selected observations have no source timestamp and are absent from the timeline.`
      : availability.reason;

  const bySourceMap = new Map<string, SelectedSession[]>();
  for (const input of sessions) bySourceMap.set(input.sourceType, [...(bySourceMap.get(input.sourceType) ?? []), input]);
  const bySource = [...bySourceMap.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
    ([sourceType, sourceSessions]) => ({
      sourceType,
      availability: sourceSessions.some((item) => item.coverage !== "COMPLETE_FOR_RETURNED_VIEW")
        || sourceSessions.some((item) => item.headSelection === "LEGACY_REVISION_ORDER")
        || sourceSessions.some((item) => !item.rawRetained)
        ? "PARTIAL" as const
        : "AVAILABLE" as const,
      sessions: sourceSessions.length,
      messages: sourceSessions.reduce((sum, item) => sum + item.selectedMessages.length, 0),
      toolInvocations: sourceSessions.reduce((sum, item) => sum + item.selectedTools.length, 0),
    }),
  );

  const toolCounts = new Map<string, number>();
  for (const tool of tools) {
    const category = safeToolCategory(tool);
    toolCounts.set(category, (toolCounts.get(category) ?? 0) + 1);
  }
  const toolCategories = [...toolCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category, count]) => ({
      category, count, percentage: tools.length === 0 ? 0 : Number((count / tools.length * 100).toFixed(2)),
    }));

  const timeline = new Map<string, { sessionsStarted: number; messages: number; toolInvocations: number }>();
  const addTimeline = (timestamp: string | null, key: "sessionsStarted" | "messages" | "toolInvocations") => {
    if (!timestamp) return;
    const date = utcDay(timestamp);
    const value = timeline.get(date) ?? { sessionsStarted: 0, messages: 0, toolInvocations: 0 };
    value[key] += 1;
    timeline.set(date, value);
  };
  for (const session of selectedSessionStarts) addTimeline(session.occurredAt, "sessionsStarted");
  for (const message of messages) addTimeline(message.occurredAt, "messages");
  for (const tool of tools) addTimeline(tool.occurredAt, "toolInvocations");
  const timelineByUtcDay = [...timeline.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([date, value]) => ({ date, ...value }));
  const userMessageCount = messages.filter((item) => item.payload.role === "user" || item.payload.role === "USER").length;
  const assistantMessageCount = messages
    .filter((item) => item.payload.role === "assistant" || item.payload.role === "ASSISTANT").length;
  const sessionsWithTools = sessions.filter((item) => item.selectedTools.length > 0).length;
  const ratio = (numerator: number, denominator: number): number | null => denominator === 0
    ? null
    : Number((numerator / denominator).toFixed(2));

  const currentEligible = sessions.filter(supportsRuleSemantics).filter((input) =>
    database.rawObservationForRevision(input.revisionId)?.dataClassification === "CONVERSATION_CONTENT");
  const semanticResults = currentEligible.map((input) => ({
    input,
    result: database.completedAnalysisForExactInputs(
      "RULE_SEMANTIC_ANALYZER", RULE_SEMANTIC_ANALYZER_VERSION, [input.revisionId],
    ),
  }));
  const analyzedSemantic = semanticResults.filter((item) => item.result !== null);
  const selectedMessageIds = new Set(messageEvidence);
  const semanticRecords = analyzedSemantic.flatMap((item) => item.result!.records)
    .filter((record) => record.recordType === "ASSERTION" && record.availability === "AVAILABLE" &&
      record.evidenceStatus === "PRESENT" &&
      record.evidenceIds.some((id) => selectedMessageIds.has(id)));
  const semanticCategoryCounts = new Map<string, number>();
  for (const record of semanticRecords) {
    const value = record.value as { category?: unknown };
    if (typeof value.category === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value.category)) {
      semanticCategoryCounts.set(value.category, (semanticCategoryCounts.get(value.category) ?? 0) + 1);
    }
  }
  const semanticsAvailability: Availability = semanticInputs.length === 0
    ? "NOT_SUPPORTED"
    : currentEligible.length === 0
      ? "NOT_RETAINED"
      : analyzedSemantic.length === 0
        ? "NOT_COLLECTED"
        : analyzedSemantic.length < currentEligible.length
          ? "PARTIAL"
          : "AVAILABLE";
  const semanticsReason = semanticsAvailability === "AVAILABLE"
    ? "Rule matches are unverified assistant assertions, not proof of task success."
    : semanticsAvailability === "PARTIAL"
      ? "Only some eligible latest revisions have completed rule semantic analysis."
      : semanticsAvailability === "NOT_COLLECTED"
        ? "Run report-usage with --allow-conversation-content to analyze retained content locally."
        : semanticsAvailability === "NOT_RETAINED"
          ? "Conversation content required for semantic analysis is not retained."
          : "The selected session sources do not support the rule semantic analyzer.";

  const telemetryRawByEvidence = new Map<string, boolean>();
  for (const input of telemetrySelectedInputs) {
    for (const observation of input.observations) telemetryRawByEvidence.set(observation.id, input.rawRetained);
  }
  const telemetryOccurrenceRecords = analyzeOtelFacts("usage-telemetry", telemetryObservations)
    .flatMap((record) => telemetryCategory(otelDefinitionKey(record.key) ?? "") ? [record] : []);
  const telemetryFactMap = new Map<string, {
    channel: "EVENT" | "METRIC";
    key: string;
    value: number;
    unit: string | null;
    occurrences: number;
    type: string | null;
    model: string | null;
    evidenceStatus: AnalysisRecord["evidenceStatus"];
  }>();
  for (const record of telemetryOccurrenceRecords) {
    const key = otelDefinitionKey(record.key);
    if (!key) continue;
    const objectValue = record.value !== null && typeof record.value === "object"
      ? record.value as Record<string, unknown>
      : null;
    const numericValue = typeof record.value === "number"
      ? record.value
      : typeof objectValue?.value === "number"
        ? objectValue.value
        : typeof objectValue?.requests === "number"
          ? objectValue.requests
          : null;
    if (numericValue === null) continue;
    const type = safeTelemetryLabel(objectValue?.type);
    const model = safeTelemetryLabel(objectValue?.model);
    if (key === "telemetry.event.model.request" && model === null) continue;
    const channel = key.startsWith("telemetry.event.") ? "EVENT" as const : "METRIC" as const;
    const groupingKey = JSON.stringify([channel, key, record.unit, type, model]);
    const rawPresent = record.evidenceIds.every((id) => telemetryRawByEvidence.get(id) !== false);
    const existing = telemetryFactMap.get(groupingKey);
    if (existing) {
      existing.value += numericValue;
      existing.occurrences += 1;
      if (!rawPresent) existing.evidenceStatus = "EVIDENCE_REMOVED";
    } else {
      telemetryFactMap.set(groupingKey, {
        channel, key, value: numericValue, unit: record.unit, occurrences: 1, type, model,
        evidenceStatus: rawPresent ? "PRESENT" : "EVIDENCE_REMOVED",
      });
    }
  }
  const telemetryFacts = [...telemetryFactMap.values()].sort((left, right) =>
    left.channel.localeCompare(right.channel) || left.key.localeCompare(right.key) ||
    (left.type ?? "").localeCompare(right.type ?? "") || (left.model ?? "").localeCompare(right.model ?? ""));
  const telemetryInScope = sourceTypeSet.size === 0 || sourceTypeSet.has("CLAUDE_CODE");
  const telemetryHasRemovedEvidence = telemetryFacts.some((item) => item.evidenceStatus !== "PRESENT");
  const telemetryAvailability: Availability = !telemetryInScope
    ? "NOT_SUPPORTED"
    : telemetryFacts.length === 0
      ? "NOT_COLLECTED"
      : telemetryHasRemovedEvidence || telemetryExcludedUndated > 0
        ? "PARTIAL"
        : "AVAILABLE";
  const telemetryReason = telemetryAvailability === "NOT_SUPPORTED"
    ? "Claude OTel telemetry is outside the selected source scope."
    : telemetryAvailability === "NOT_COLLECTED"
      ? "No retained Claude OTel token, model, cost, or latency facts match the report scope."
      : telemetryAvailability === "PARTIAL"
        ? "Some matching telemetry has removed evidence or no source timestamp. Event and metric channels remain separate."
        : "Event and metric channels remain separate because they can overlap. Estimated Vendor cost is not billing truth.";
  const telemetryCategories = Object.fromEntries((["tokens", "model", "cost", "latency"] as const).map(
    (category) => {
      const facts = telemetryFacts.filter((item) => telemetryCategory(item.key) === category ||
        (category === "model" && item.model !== null));
      const availability: Availability = !telemetryInScope
        ? "NOT_SUPPORTED"
        : facts.length === 0
          ? "NOT_COLLECTED"
          : facts.some((item) => item.evidenceStatus !== "PRESENT")
            ? "PARTIAL"
            : "AVAILABLE";
      return [category, availability];
    },
  )) as UsageReportOutput["telemetry"]["categories"];

  const selectedEvidence = [...sessionEvidence, ...messageEvidence, ...toolEvidence, ...telemetryEvidence];
  const verificationRecords = database.verificationRecordsForEvidenceIds(selectedEvidence);
  const verificationCounts = new Map<string, number>();
  for (const record of verificationRecords) {
    const verificationType = VERIFICATION_TYPES.includes(record.verificationType)
      ? record.verificationType
      : "UNKNOWN";
    const status = VERIFICATION_STATUSES.includes(record.status) ? record.status : "UNKNOWN";
    const key = `${verificationType}\u0000${status}`;
    verificationCounts.set(key, (verificationCounts.get(key) ?? 0) + 1);
  }
  const verificationRemoved = verificationRecords.filter(
    (item) => item.analysisEvidenceStatus === "EVIDENCE_REMOVED").length;
  const verificationInvalidated = verificationRecords.filter(
    (item) => item.analysisEvidenceStatus === "INVALIDATED").length;
  const verificationAvailability: Availability = verificationRecords.length === 0
    ? "NOT_COLLECTED"
    : verificationRemoved > 0 || verificationInvalidated > 0
      ? "PARTIAL"
      : "AVAILABLE";
  const verificationReason = verificationAvailability === "NOT_COLLECTED"
    ? "No VerificationRecord is connected to evidence in the selected report scope."
    : verificationAvailability === "PARTIAL"
      ? "One or more verified analysis records have removed or invalidated evidence."
      : "Verification is reported separately from observed, calculated, and inferred results.";
  const selectedRevisionIds = [...new Set([
    ...sessions.map((item) => item.revisionId),
    ...telemetrySelectedInputs.map((item) => item.revisionId),
  ])];
  const annotationCounts = database.annotationCountsForScope(selectedRevisionIds, selectedEvidence);
  const annotationTotal = annotationCounts.sourceRevision + annotationCounts.analysisRecord;

  const report: UsageReportOutput = {
    schemaVersion: "axtory.usage-report.v2", generatedAt, analysisRunId,
    analyzerVersion: USAGE_REPORT_ANALYZER_VERSION, derivation: "CALCULATED",
    scope: {
      since, until, sourceTypes, latestRevisionPerSourceObject: true,
      timeSemantics: "SOURCE_OCCURRED_AT",
    },
    totals: {
      availability: availability.availability, reason: availability.reason,
      sessions: hasSource ? sessions.length : null,
      messages: hasSource ? messages.length : null,
      userMessages: hasSource ? userMessageCount : null,
      assistantMessages: hasSource ? assistantMessageCount : null,
      toolInvocations: hasSource ? tools.length : null,
      firstActivityAt: activities[0] ?? null, lastActivityAt: activities.at(-1) ?? null,
    },
    sessionDistribution: {
      messagesPerSession: distribution(sessions.map((item) => item.selectedMessages.length)),
      toolsPerSession: distribution(sessions.map((item) => item.selectedTools.length)),
    },
    patterns: {
      activeUtcDays: hasSource ? timelineByUtcDay.length : null,
      sessionsWithTools: hasSource ? sessionsWithTools : null,
      sessionsWithToolsPercentage: hasSource ? ratio(sessionsWithTools * 100, sessions.length) : null,
      assistantMessagesPerUserMessage: hasSource ? ratio(assistantMessageCount, userMessageCount) : null,
      toolInvocationsPerAssistantMessage: hasSource ? ratio(tools.length, assistantMessageCount) : null,
    },
    coverage: {
      completeSessions, partialSessions, unknownSessions,
      completedCollectionHeads, legacyFallbackHeads,
      excludedUndatedObservations: selected.excludedUndatedObservations,
      timelineAvailability, timelineReason,
    },
    evidence: {
      status: reportEvidenceStatus, revisionsWithRaw, revisionsWithoutRaw,
      reason: revisionsWithoutRaw > 0
        ? "Normalized observations remain, but Raw evidence was removed for one or more report inputs."
        : null,
    },
    bySource, toolCategories, timelineByUtcDay,
    semantics: {
      derivation: "INFERRED", availability: semanticsAvailability, reason: semanticsReason,
      candidateRevisions: semanticInputs.length, eligibleRevisions: currentEligible.length,
      analyzedRevisions: analyzedSemantic.length,
      assertions: analyzedSemantic.length > 0 ? semanticRecords.length : null,
      categories: [...semanticCategoryCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([category, count]) => ({ category, count })),
    },
    telemetry: {
      availability: telemetryAvailability, reason: telemetryReason,
      excludedUndatedObservations: telemetryExcludedUndated,
      categories: telemetryCategories, facts: telemetryFacts,
    },
    verification: {
      availability: verificationAvailability, reason: verificationReason,
      records: verificationRecords.length > 0 ? verificationRecords.length : null,
      byTypeAndStatus: [...verificationCounts.entries()].map(([key, count]) => {
        const [verificationType, status] = key.split("\u0000");
        return { verificationType: verificationType!, status: status!, count };
      }).sort((left, right) => left.verificationType.localeCompare(right.verificationType) ||
        left.status.localeCompare(right.status)),
      analysisEvidence: {
        present: verificationRecords.length - verificationRemoved - verificationInvalidated,
        evidenceRemoved: verificationRemoved, invalidated: verificationInvalidated,
      },
    },
    annotations: {
      availability: annotationTotal > 0 ? "AVAILABLE" : "NOT_COLLECTED",
      reason: annotationTotal > 0
        ? "User annotations remain separate from source observations and analysis results."
        : "No UserAnnotation is connected to the selected report scope.",
      records: annotationTotal > 0 ? annotationTotal : null,
      sourceRevisionRecords: annotationCounts.sourceRevision,
      analysisRecordRecords: annotationCounts.analysisRecord,
    },
    limitations: [
      "The report describes latest retained source views, not all historical revisions added together.",
      "Session, message, and tool counts are usage occurrences, not completed work or AI contribution.",
      "Partial, compacted, bounded, or undated source views limit comparisons and timelines.",
      "Tool output uses privacy-safe categories; custom extension names are not exported.",
      "Semantic categories are opt-in, rule-based INFERRED assertions and are not verification.",
      "Verification records are user- or process-supplied checks; they do not rewrite the underlying analysis.",
      "OTel event and metric channels can overlap and are never combined with each other.",
      "Model and telemetry values exist only when the user separately enabled and collected Claude OTel.",
      "For a bounded report, opt-in rules read each selected latest revision and report only assertions backed by in-window messages.",
      "This report does not estimate ROI, time saved, causality, quality, or impact.",
    ],
  };

  const value = hasSource ? (input: number) => input : (_input: number) => null;
  const records = [
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.session.count"], value(sessions.length),
      availability.availability, availability.reason, sessionEvidence, reportEvidenceStatus),
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.message.count"], value(messages.length),
      availability.availability, availability.reason, messageEvidence, reportEvidenceStatus),
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.tool.invocation.count"], value(tools.length),
      availability.availability, availability.reason, toolEvidence, reportEvidenceStatus),
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.active_day.count"], value(timelineByUtcDay.length),
      timelineAvailability, timelineReason, [...sessionEvidence, ...messageEvidence, ...toolEvidence],
      reportEvidenceStatus),
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.session.with_tools.percentage"],
      hasSource ? ratio(sessionsWithTools * 100, sessions.length) : null,
      sessions.length === 0 ? "UNKNOWN" : availability.availability,
      sessions.length === 0 ? "No selected sessions are available for a percentage denominator." : availability.reason,
      [...sessionEvidence, ...toolEvidence], reportEvidenceStatus),
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.assistant_per_user_message.ratio"],
      hasSource ? ratio(assistantMessageCount, userMessageCount) : null,
      userMessageCount === 0 ? "UNKNOWN" : availability.availability,
      userMessageCount === 0 ? "No selected user messages are available for the ratio denominator." : availability.reason,
      messageEvidence, reportEvidenceStatus),
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.tool_per_assistant_message.ratio"],
      hasSource ? ratio(tools.length, assistantMessageCount) : null,
      assistantMessageCount === 0 ? "UNKNOWN" : availability.availability,
      assistantMessageCount === 0 ? "No selected assistant messages are available for the ratio denominator." : availability.reason,
      [...messageEvidence, ...toolEvidence], reportEvidenceStatus),
    reportMetric(analysisRunId, USAGE_METRIC_CATALOG["usage.report.semantic.assertion.count"],
      semanticsAvailability === "AVAILABLE" || semanticsAvailability === "PARTIAL" ? semanticRecords.length : null,
      semanticsAvailability, semanticsReason, semanticRecords.flatMap((record) => record.evidenceIds),
      semanticsAvailability === "NOT_RETAINED" ? "EVIDENCE_REMOVED" : "PRESENT"),
  ];

  database.startAnalysisRun({
    id: analysisRunId, analyzerType: "USAGE_REPORT_ANALYZER",
    analyzerVersion: USAGE_REPORT_ANALYZER_VERSION,
    inputRevisionIds: [...sessions.map((item) => item.revisionId),
      ...telemetrySelectedInputs.map((item) => item.revisionId)],
    startedAt: generatedAt,
  });
  try {
    database.transaction(() => database.insertAnalysisRecords(records));
    const payloadDigest = await writeJsonAtomically(options.jsonOutputPath, report);
    database.recordExport({
      id: `export_${randomId()}`, sink: "JSON_FILE", destination: options.jsonOutputPath,
      policyVersion: OUTPUT_POLICY_VERSION, recordCount: records.length,
      classifications: ["LOCAL_METADATA"], status: "COMPLETED", payloadDigest, exportedAt: now().toISOString(),
    });
    database.finishAnalysisRun(analysisRunId, "COMPLETED", now().toISOString());
    return report;
  } catch (error) {
    database.finishAnalysisRun(analysisRunId, "FAILED", now().toISOString(), "ANALYSIS_ERROR");
    throw error;
  } finally {
    database.close();
  }
}

export function renderUsageReport(report: UsageReportOutput): string {
  const clean = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u009B]/gu, "");
  const lines = [
    "AXtory AI usage report",
    `Coverage: ${report.totals.availability}${report.totals.reason ? ` (${report.totals.reason})` : ""}`,
    `Period: ${report.scope.since ?? "beginning"} to ${report.scope.until ?? "latest"}`,
    `Sessions: ${report.totals.sessions ?? "unavailable"}`,
    `Messages: ${report.totals.messages ?? "unavailable"} ` +
      `(user ${report.totals.userMessages ?? "unavailable"}, assistant ${report.totals.assistantMessages ?? "unavailable"})`,
    `Tool invocations: ${report.totals.toolInvocations ?? "unavailable"}`,
    `Messages/session: median ${report.sessionDistribution.messagesPerSession.median ?? "unavailable"}, ` +
      `p90 ${report.sessionDistribution.messagesPerSession.p90 ?? "unavailable"}`,
    `Tools/session: median ${report.sessionDistribution.toolsPerSession.median ?? "unavailable"}, ` +
      `p90 ${report.sessionDistribution.toolsPerSession.p90 ?? "unavailable"}`,
    `Active UTC days: ${report.patterns.activeUtcDays ?? "unavailable"}`,
    `Sessions using tools: ${report.patterns.sessionsWithTools ?? "unavailable"} ` +
      `(${report.patterns.sessionsWithToolsPercentage?.toFixed(2) ?? "unavailable"}%)`,
    `Assistant/user message ratio: ${report.patterns.assistantMessagesPerUserMessage ?? "unavailable"}`,
    `Tool/assistant message ratio: ${report.patterns.toolInvocationsPerAssistantMessage ?? "unavailable"}`,
    `Session views: ${report.coverage.completeSessions} complete, ${report.coverage.partialSessions} partial, ` +
      `${report.coverage.unknownSessions} unknown`,
    `Revision heads: ${report.coverage.completedCollectionHeads} completed-collection, ` +
      `${report.coverage.legacyFallbackHeads} legacy fallback`,
    `Evidence: ${report.evidence.status} (${report.evidence.revisionsWithRaw} raw retained, ` +
      `${report.evidence.revisionsWithoutRaw} raw removed)`,
    "Sources:",
    ...report.bySource.map((item) =>
      `  ${item.sourceType}: ${item.sessions} sessions, ${item.messages} messages, ` +
      `${item.toolInvocations} tools [${item.availability}]`),
    "Tool categories:",
    ...report.toolCategories.slice(0, 10).map((item) =>
      `  ${item.category}: ${item.count} (${item.percentage.toFixed(2)}%)`),
    `Semantics: ${report.semantics.availability}` +
      (report.semantics.assertions === null ? "" : `, ${report.semantics.assertions} unverified assertions`),
    `Semantic note: ${report.semantics.reason ?? "none"}`,
    `Telemetry: ${report.telemetry.availability} ` +
      `(tokens ${report.telemetry.categories.tokens}, model ${report.telemetry.categories.model}, ` +
      `cost ${report.telemetry.categories.cost}, latency ${report.telemetry.categories.latency})`,
    ...report.telemetry.facts.slice(0, 10).map((item) =>
      `  ${item.channel} ${item.key}: ${item.value} ${item.unit ?? "unit unavailable"}` +
      `${item.type ? ` [type ${item.type}]` : ""}${item.model ? ` [model ${item.model}]` : ""}` +
      ` [${item.evidenceStatus}]`),
    `Verification: ${report.verification.availability}` +
      (report.verification.records === null ? "" : `, ${report.verification.records} records`),
    ...report.verification.byTypeAndStatus.map((item) =>
      `  ${item.verificationType}/${item.status}: ${item.count}`),
    `Annotations: ${report.annotations.availability}` +
      (report.annotations.records === null ? "" : `, ${report.annotations.records} records`),
  ];
  return `${lines.map(clean).join("\n").slice(0, 16_384)}\n`;
}
