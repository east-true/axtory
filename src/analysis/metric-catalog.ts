export interface MetricDefinition {
  key: string;
  description: string;
  unit: "count";
  derivation: "CALCULATED";
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
} as const satisfies Record<string, MetricDefinition>;
