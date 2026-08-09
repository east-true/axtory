export interface MetricDefinition {
  key: string;
  description: string;
  unit: "count" | "tokens";
  derivation: "OBSERVED" | "CALCULATED";
  aggregation: "SUM";
  requiredSource: string;
  formulaVersion: string;
  limitations: readonly string[];
}

export const METRIC_CATALOG = {
  "session.count": {
    key: "session.count",
    description: "Number of session snapshots in the returned view",
    unit: "count",
    derivation: "CALCULATED",
    aggregation: "SUM",
    requiredSource: "session snapshot",
    formulaVersion: "1",
    limitations: ["A session is not equivalent to a completed unit of work."],
  },
  "message.count": {
    key: "message.count",
    description: "Number of normalized message content occurrences in the returned view",
    unit: "count",
    derivation: "CALCULATED",
    aggregation: "SUM",
    requiredSource: "message content occurrence",
    formulaVersion: "1",
    limitations: ["Compaction or retention can make the returned view incomplete."],
  },
  "tool.invocation.count": {
    key: "tool.invocation.count",
    description: "Number of normalized tool-use occurrences in the returned view",
    unit: "count",
    derivation: "CALCULATED",
    aggregation: "SUM",
    requiredSource: "tool-use occurrence",
    formulaVersion: "1",
    limitations: ["Repeated content identities remain separate usage occurrences."],
  },
  "agent.assertion.count": {
    key: "agent.assertion.count",
    description: "Number of assistant claims identified as assertions",
    unit: "count",
    derivation: "CALCULATED",
    aggregation: "SUM",
    requiredSource: "versioned assertion classifier",
    formulaVersion: "1",
    limitations: ["Free-form assistant content is not treated as a verified assertion."],
  },
  "usage.input.tokens": {
    key: "usage.input.tokens",
    description: "Source-agent input token usage",
    unit: "tokens",
    derivation: "OBSERVED",
    aggregation: "SUM",
    requiredSource: "official usage telemetry",
    formulaVersion: "1",
    limitations: ["Claude Local History is not treated as authoritative usage telemetry."],
  },
  "usage.output.tokens": {
    key: "usage.output.tokens",
    description: "Source-agent output token usage",
    unit: "tokens",
    derivation: "OBSERVED",
    aggregation: "SUM",
    requiredSource: "official usage telemetry",
    formulaVersion: "1",
    limitations: ["Claude Local History is not treated as authoritative usage telemetry."],
  },
} as const satisfies Record<string, MetricDefinition>;
