# AXtory

[English](README.md) | [한국어](README.ko.md)

AXtory is a local-first observer for AI-assisted work. It collects evidence exposed by
tools such as Claude Code and Codex without becoming the agent runner or prompt proxy.

Project planning, architecture, delivery phases, and Connector evidence are indexed in
[`docs/README.md`](docs/README.md). The Korean planning and design documents are the current
project baseline; implementation status is kept separate from proposed behavior.

The repository contains privacy-safe Claude and Codex contract spikes, a Fixture-backed Core
walking skeleton, official-API history collectors, opt-in semantic and live analysis, a
metadata-minimizing Local Git artifact collector, and GitHub/GitLab/Jira/Linear work-system
connectors. A local usage report aggregates the latest retained revisions into time, source,
session, and privacy-safe tool patterns. Raw data stays in local immutable revisions while
sanitized projections and evidence-aware analysis remain separate.

## Current guarantees

- Read-only by default; no vendor settings are changed.
- No remote telemetry, error reporting, prompt upload, or code upload.
- Missing data is represented by availability and reason, never by a synthetic zero.
- Vendor data, canonical observations, and analytics are separate layers.
- The Core builds and tests without a Claude or Codex SDK.
- No internal Claude or Codex JSONL parser is used.
- Semantic findings and Git correlations are never presented as verified facts.
- Hook and OTel collection require explicit configuration consent, bind to loopback, and can be
  restored from an exact settings backup.
- Work-system tokens are accepted only from named environment variables; titles, descriptions,
  comments, logs, user identities, URLs, and repository names are excluded from persisted views.
- Additional AI sources expose provider-specific coverage; AXtory never converts a session list
  or an unstructured log into invented message or tool facts.

## Development

Requires Node.js 24 or later.

```sh
npm install
npm test
```

Run the synthetic end-to-end path twice to see content-hash idempotency:

```sh
npm run skeleton
npm run skeleton
```

The optional Claude spike requires the user-installed Claude Code executable and a separately
installed official Agent SDK. AXtory does not bundle either:

```sh
npm install --no-save --omit=optional @anthropic-ai/claude-agent-sdk@0.3.220
npm run spike:claude -- --output local-spike-results/claude.json
```

The spike report contains structural metadata only. See
[`docs/research/connector-contracts.md`](docs/research/connector-contracts.md).

## Codex history

Codex collection uses the user-installed `codex` executable and the official App Server. Because
App Server initializes writable runtime state even for read methods, AXtory first creates a
consistent SQLite backup in a temporary private `CODEX_HOME`. It then calls only `thread/list`
with `useStateDbOnly: true` and `thread/read`; the original Codex state database is never opened
for writing and AXtory does not parse rollout JSONL.

Run a content-free structural spike or collect history locally:

```sh
npm run spike:codex
npm run build
node dist/src/cli.js collect-codex \
  --data-dir .local/axtory-codex \
  --json-out .local/axtory-codex/output.json
```

`--page-size` and `--max-pages` bound both active and archived enumeration. A bound hit, repeated
cursor, duplicate, active thread, compaction event, or non-full turn view remains explicitly
partial. Raw prompts, responses, and tool payloads are sensitive local evidence; do not publish
the data directory.

## Claude Code Local History

Install the official SDK separately, then run the collector:

```sh
npm install --no-save --omit=optional @anthropic-ai/claude-agent-sdk@0.3.220
npm run build
node dist/src/cli.js collect-claude \
  --data-dir .local/axtory-claude \
  --json-out .local/axtory-claude/output.json
```

Optional `--project-dir`, `--page-size`, and `--max-pages` arguments bound the returned view.
Limit hits are reported as `PARTIAL_PAGINATION`; they are never presented as complete.

The command reads through the official SDK and does not change Claude configuration. Prompts,
responses, session metadata, and tool payloads in the returned view are sensitive and are stored
in the local content-addressed Blob Store with user-only file permissions. Console and JSON
summaries exclude those raw values. Do not publish `.local` data.

To delete an entire AXtory data directory, use the marker-guarded destructive command:

```sh
node dist/src/cli.js purge --data-dir .local/axtory-claude --confirm PURGE_ALL
```

In addition to `PURGE_ALL`, selective raw/session deletion and retention automation are available
with explicit modes. Inspect opaque local IDs without exposing Vendor keys:

```sh
node dist/src/cli.js list --data-dir .local/axtory-claude
node dist/src/cli.js delete --data-dir .local/axtory-claude \
  --mode DELETE_RAW_ONLY --revision-id revision_... --confirm DELETE_RAW_ONLY
node dist/src/cli.js retain --data-dir .local/axtory-claude \
  --classification CONVERSATION_CONTENT --days 30
```

`DELETE_RAW_AND_DERIVED` and `DELETE_SOURCE_SESSION` use the same exact confirmation rule. These
operations apply SQLite secure deletion and WAL checkpointing, remove unreferenced blobs, update
dependent Evidence state, and cover matching pending live Spool entries.

Reports export annotation and verification counts only, so the text you write with `annotate` and
`verify --note` is read back through a separate console-only command:

```sh
node dist/src/cli.js list-annotations --data-dir .local/axtory-claude
node dist/src/cli.js list-annotations --data-dir .local/axtory-claude \
  --target-type SOURCE_REVISION --target-id revision_...
```

It prints to stdout, writes no file, and records no export run.

Each annotation carries a DataClassification, `PERSONAL_DATA` unless `--classification` selects
another, so retention expires annotation text on the same terms as any other local content:

```sh
node dist/src/cli.js annotate --data-dir .local/axtory-claude \
  --target-type SOURCE_REVISION --target-id revision_... \
  --assertion "manual baseline: about four hours" --classification PERSONAL_DATA
node dist/src/cli.js retain --data-dir .local/axtory-claude \
  --classification PERSONAL_DATA --days 30
```

That rule covers annotations only. A verification note left by `verify --note` is a separate record
with no classification of its own, so retention does not expire it; it is removed when the analysis
record it verifies is deleted.

## Additional AI sources

The snapshot collector supports Gemini CLI, OpenCode, Cursor Agent, and Aider without bundling
their executables or changing their settings:

```sh
npm run build
node dist/src/cli.js collect-additional-ai \
  --provider opencode --project-dir . \
  --data-dir .local/axtory-opencode --json-out .local/axtory-opencode/output.json

node dist/src/cli.js collect-additional-ai \
  --provider aider --project-dir . --history-file .aider.chat.history.md \
  --data-dir .local/axtory-aider --json-out .local/axtory-aider/output.json
```

Use `--provider gemini` or `--provider cursor` for the other installed CLIs, and `--limit` to
bound enumeration. Capabilities differ by the official read interfaces each provider exposes:

| Provider | Source contract | Message/tool facts |
| --- | --- | --- |
| OpenCode | JSON session list and export | Available for the returned export |
| Gemini CLI | Session list | `NOT_COLLECTED`; metadata only |
| Cursor Agent | Session list | `NOT_COLLECTED`; metadata only |
| Aider | Explicit chat-history Markdown file | `NOT_SUPPORTED`; raw log only |

Conversation exports and Aider Markdown remain sensitive local blobs. Console and JSON output
contain only aggregate counts, Availability, coverage, and evidence status. See
[`docs/research/additional-ai-contracts.md`](docs/research/additional-ai-contracts.md) for the
contract evidence and limitations.

## Semantic and Git analysis

Generate a user-facing usage report after collecting one or more AI sources:

```sh
node dist/src/cli.js report-usage \
  --data-dir .local/axtory-codex \
  --json-out .local/axtory-codex/usage-report.json \
  --source codex
```

Repeat `--source` to combine selected providers, or omit it to include every collected session
source. A report reads exactly one local `--data-dir`: repeated `--source` combines providers only
when those collectors wrote to that same directory. It does not federate separate directories such
as `.local/axtory-claude` and `.local/axtory-codex`; use one shared directory when a combined report
is required. `--since` and `--until` accept ISO-8601 timestamps and form a half-open source-time
window. The report uses only the latest Revision per SourceObject, exposes partial/unknown coverage
and removed Raw evidence, groups custom extension names into privacy-safe tool categories, and
includes daily UTC activity in JSON. Sources collected before schema v5 without an observed head
relation remain visible as an explicit partial legacy fallback. Counts and ratios describe usage
patterns, not productivity, quality, or AI impact.

When the same directory also contains explicitly enabled Claude OTel collection, the report shows
token, model, estimated cost, and latency facts without combining potentially overlapping event and
metric channels. Missing telemetry stays `NOT_COLLECTED`. Verification and UserAnnotation records
connected to the selected evidence are shown as privacy-safe counts; notes and annotation text are
not exported, and neither record type rewrites the underlying result.

Semantic categories remain off by default. To read retained conversation content locally and
integrate narrow rule-matched, unverified assertions, give explicit consent. One invocation is
limited to 100 eligible revisions; narrow the source or time window for larger histories:

```sh
node dist/src/cli.js report-usage \
  --data-dir .local/axtory-codex \
  --json-out .local/axtory-codex/usage-report.json \
  --source codex --allow-conversation-content
```

For a bounded report, the local rule analyzer reads each selected latest Revision in full but
includes only assertions backed by messages inside the report window.

Rule analysis reads retained conversation content only after explicit consent. Its assertion
matches are `INFERRED`, never verification:

```sh
node dist/src/cli.js analyze-rule --data-dir .local/axtory-claude \
  --revision-id revision_... --allow-conversation-content
```

Local/remote model integrations use a strict tool-less structured-result adapter; AXtory does not
bundle or configure a model provider. Local Git collection excludes paths, diffs, commit messages,
and author identities. An optional user-selected session link is temporal correlation only:

```sh
node dist/src/cli.js collect-git --repo-dir . --data-dir .local/axtory \
  --json-out .local/axtory/git-output.json --session-revision-id revision_...
```

## Work systems

GitHub and GitLab expose change requests, CI runs, and deployments. Jira and Linear expose work
items. Collection uses official HTTPS APIs, bounded pagination, immutable revisions, and a small
metadata allowlist. Unsupported artifact types are `NOT_SUPPORTED`, not zero.

```sh
npm run build
node dist/src/cli.js collect-work-system \
  --provider github --repository OWNER/REPOSITORY \
  --data-dir .local/axtory-work --json-out .local/axtory-work/github.json

node dist/src/cli.js collect-work-system \
  --provider gitlab --project GROUP/PROJECT \
  --data-dir .local/axtory-work --json-out .local/axtory-work/gitlab.json

node dist/src/cli.js collect-work-system \
  --provider jira --base-url https://example.atlassian.net --project AX \
  --data-dir .local/axtory-work --json-out .local/axtory-work/jira.json

node dist/src/cli.js collect-work-system \
  --provider linear --team-id TEAM_ID \
  --data-dir .local/axtory-work --json-out .local/axtory-work/linear.json
```

Configure `GITHUB_TOKEN`, `GITLAB_TOKEN`, `JIRA_EMAIL`/`JIRA_API_TOKEN`, or `LINEAR_API_KEY`
through the shell's secret facility before running the applicable command. Public GitHub and GitLab
repositories can be read without a token, subject to their API limits. Use `--token-env` and, for
Jira, `--email-env` to select different environment variable names; literal credential flags are
rejected. `--page-size` and `--max-pages` bound enumeration.

To link explicit PR/CI/deployment commit identities to a previously collected Local Git snapshot,
pass `--git-revision-id revision_...`. A match is `OBSERVED`; AXtory does not infer a work item/PR
link or claim authorship, causality, completion, or AI contribution.

## Optional live Hook and OTel collection

Live collection is off until the user starts the receiver and explicitly approves a Claude
settings change. The receiver accepts authenticated HTTP Hook and OTLP `http/json` traffic on
IPv4 loopback, writes a bounded crash-recoverable Spool, and disables content-bearing OTel gates:

```sh
node dist/src/cli.js plan-live --settings /path/to/claude/settings.json \
  --enable-hooks --enable-otel
node dist/src/cli.js serve-live --data-dir .local/axtory-live \
  --settings /path/to/claude/settings.json --enable-hooks --enable-otel \
  --confirm APPLY_CLAUDE_LIVE_CONFIG
```

After stopping the receiver, ingest the Spool and restore the exact backup path printed by setup:

```sh
node dist/src/cli.js ingest-live --data-dir .local/axtory-live \
  --json-out .local/axtory-live/output.json
node dist/src/cli.js rollback-live --settings /path/to/claude/settings.json \
  --backup /path/to/.axtory-backups/settings-....json \
  --confirm ROLLBACK_CLAUDE_LIVE_CONFIG
```

Token, model, estimated cost, and latency facts are namespaced by OTel channel. Missing categories
remain `NOT_COLLECTED`; estimated Vendor cost is not billing truth. To see these facts beside a
Claude Session report, collect snapshot and live sources into the same local data directory. AXtory
does not merge independent SQLite data directories during reporting.

## Non-goals for the technical MVP

AXtory does not run agents, automatically group work, estimate ROI, assign an AI contribution
percentage, automatically enable hooks or OpenTelemetry, bundle a semantic model provider, or
provide a public connector plugin SPI.

### Why those numbers are missing, and what to do instead

An AI contribution percentage, an ROI figure, and a time-saving estimate share one cause for their
absence: each needs a baseline for work that never happened, and a local observer cannot read that
alternative. Vendor-reported cost has a published price list behind it, so AXtory passes it through
as an observed value. "How long this would have taken without an agent" has no such source, and
inventing one would contradict the rule that keeps an unknown value explicitly unknown.

Model those questions outside AXtory, where the assumptions stay visible and belong to whoever
states them. A report exports as JSON that keeps calculated usage totals separate from inferred
semantic assertions, marks missing data with Availability rather than zero, and lists in
`limitations` what the figures do not establish.

Two habits keep that outside model closer to evidence:

- Record a baseline while the work is fresh instead of reconstructing it afterwards. `annotate`
  stores the claim against the revision it belongs to, and `list-annotations` reads it back. It
  stays your assertion; AXtory never folds it into a computed result.
- Compare periods you actually observed instead of measuring one against a guess. Two `report-usage`
  runs over different `--since`/`--until` windows produce two measured distributions. The contrast
  is real, but attributing it to the agent remains your inference rather than the tool's.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting code or fixtures. Never attach real
Claude or Codex sessions to an issue. Security reporting guidance is in
[`SECURITY.md`](SECURITY.md).

## License

AXtory is licensed under Apache License 2.0. Vendor products and SDKs remain separately
licensed and are not redistributed by this repository.
