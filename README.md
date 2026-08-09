# AXtory

AXtory is a local-first observer for AI-assisted work. It collects evidence exposed by
tools such as Claude Code and Codex without becoming the agent runner or prompt proxy.

Project planning, architecture, delivery phases, and Connector evidence are indexed in
[`docs/README.md`](docs/README.md). The Korean planning and design documents are the current
project baseline; implementation status is kept separate from proposed behavior.

The repository contains privacy-safe Claude and Codex contract spikes, a Fixture-backed Core
walking skeleton, official-API history collectors, opt-in semantic and live analysis, and a
metadata-minimizing Local Git artifact collector. Raw data stays in local immutable revisions
while sanitized projections and evidence-aware analysis remain separate.

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

## Semantic and Git analysis

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
remain `NOT_COLLECTED`; estimated Vendor cost is not billing truth.

## Non-goals for the technical MVP

AXtory does not run agents, automatically group work, estimate ROI, assign an AI contribution
percentage, automatically enable hooks or OpenTelemetry, bundle a semantic model provider, or
provide a public connector plugin SPI.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting code or fixtures. Never attach real
Claude or Codex sessions to an issue. Security reporting guidance is in
[`SECURITY.md`](SECURITY.md).

## License

AXtory is licensed under Apache License 2.0. Vendor products and SDKs remain separately
licensed and are not redistributed by this repository.
