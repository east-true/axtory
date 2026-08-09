export interface MetricDefinition {
  key: string;
  description: string;
  unit: string;
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

export const OTEL_METRIC_CATALOG = {
  "telemetry.event.usage.input": {
    key: "telemetry.event.usage.input", description: "Input tokens reported by an API request event",
    unit: "tokens", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel api_request event",
    formulaVersion: "1", limitations: ["Event and metric channels can overlap and are not combined automatically."],
  },
  "telemetry.event.usage.output": {
    key: "telemetry.event.usage.output", description: "Output tokens reported by an API request event",
    unit: "tokens", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel api_request event",
    formulaVersion: "1", limitations: ["Event and metric channels can overlap and are not combined automatically."],
  },
  "telemetry.event.usage.cache_read": {
    key: "telemetry.event.usage.cache_read", description: "Cache-read tokens reported by an API request event",
    unit: "tokens", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel api_request event",
    formulaVersion: "1", limitations: [],
  },
  "telemetry.event.usage.cache_creation": {
    key: "telemetry.event.usage.cache_creation", description: "Cache-creation tokens reported by an API request event",
    unit: "tokens", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel api_request event",
    formulaVersion: "1", limitations: [],
  },
  "telemetry.event.cost.estimated": {
    key: "telemetry.event.cost.estimated", description: "Vendor-estimated API request cost",
    unit: "USD", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel api_request event",
    formulaVersion: "1", limitations: ["This is an estimate and not authoritative billing data."],
  },
  "telemetry.event.cost.estimated_micros": {
    key: "telemetry.event.cost.estimated_micros", description: "Vendor-estimated API request cost in micro-USD",
    unit: "microUSD", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel api_request event",
    formulaVersion: "1", limitations: ["This is an estimate and not authoritative billing data."],
  },
  "telemetry.event.latency.duration": {
    key: "telemetry.event.latency.duration", description: "API request wall-clock duration",
    unit: "ms", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel event",
    formulaVersion: "1", limitations: ["Summed duration is not elapsed session time."],
  },
  "telemetry.event.latency.time_to_first_token": {
    key: "telemetry.event.latency.time_to_first_token", description: "API request time to first token",
    unit: "ms", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel event",
    formulaVersion: "1", limitations: [],
  },
  "telemetry.event.model.request": {
    key: "telemetry.event.model.request", description: "Model label attached to one API request event",
    unit: "count", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel api_request event",
    formulaVersion: "1", limitations: ["Model strings are untrusted allowlisted labels."],
  },
  "telemetry.metric.claude_code.token.usage": {
    key: "telemetry.metric.claude_code.token.usage", description: "Claude Code token usage metric point",
    unit: "tokens", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel metric",
    formulaVersion: "1", limitations: ["Keep token type attributes separate."],
  },
  "telemetry.metric.claude_code.cost.usage": {
    key: "telemetry.metric.claude_code.cost.usage", description: "Claude Code estimated cost metric point",
    unit: "USD", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel metric",
    formulaVersion: "1", limitations: ["This is an estimate and not authoritative billing data."],
  },
  "telemetry.metric.claude_code.session.count": {
    key: "telemetry.metric.claude_code.session.count", description: "Claude Code session count metric point",
    unit: "count", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel metric",
    formulaVersion: "1", limitations: ["A session is not a completed unit of work."],
  },
  "telemetry.metric.claude_code.lines_of_code.count": {
    key: "telemetry.metric.claude_code.lines_of_code.count", description: "Claude Code lines-of-code metric point",
    unit: "count", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel metric",
    formulaVersion: "1", limitations: ["This is a Vendor-reported occurrence metric, not impact attribution."],
  },
  "telemetry.metric.claude_code.commit.count": {
    key: "telemetry.metric.claude_code.commit.count", description: "Claude Code commit count metric point",
    unit: "count", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel metric",
    formulaVersion: "1", limitations: ["This does not establish causal attribution."],
  },
  "telemetry.metric.claude_code.pull_request.count": {
    key: "telemetry.metric.claude_code.pull_request.count", description: "Claude Code pull request count metric point",
    unit: "count", derivation: "OBSERVED", aggregation: "SUM", requiredSource: "Claude OTel metric",
    formulaVersion: "1", limitations: ["This does not establish causal attribution."],
  },
} as const satisfies Record<string, MetricDefinition>;

const workMetric = (key: string, description: string): MetricDefinition => ({
  key, description, unit: "count", derivation: "CALCULATED", aggregation: "SUM",
  requiredSource: "Work-system official API returned view", formulaVersion: "1",
  limitations: ["Counts describe returned artifacts and do not establish completion, quality, or AI attribution."],
});

export const WORK_METRIC_CATALOG = {
  "work.change_request.count": workMetric("work.change_request.count", "Change requests in the returned view"),
  "work.change_request.merged.count": workMetric("work.change_request.merged.count", "Merged change requests"),
  "work.ci_run.count": workMetric("work.ci_run.count", "CI runs in the returned view"),
  "work.ci_run.succeeded.count": workMetric("work.ci_run.succeeded.count", "Successful CI runs"),
  "work.ci_run.failed.count": workMetric("work.ci_run.failed.count", "Failed CI runs"),
  "work.deployment.count": workMetric("work.deployment.count", "Deployments in the returned view"),
  "work.deployment.succeeded.count": workMetric("work.deployment.succeeded.count", "Successful deployments"),
  "work.deployment.failed.count": workMetric("work.deployment.failed.count", "Failed deployments"),
  "work.item.count": workMetric("work.item.count", "Work items in the returned view"),
  "work.item.completed.count": workMetric("work.item.completed.count", "Completed work items"),
} as const satisfies Record<string, MetricDefinition>;
