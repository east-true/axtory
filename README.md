# AXtory

AXtory is a local-first observer for AI-assisted work. It collects evidence exposed by
tools such as Claude Code and Codex without becoming the agent runner or prompt proxy.

Project planning, architecture, delivery phases, and Connector evidence are indexed in
[`docs/README.md`](docs/README.md). The Korean planning and design documents are the current
project baseline; implementation status is kept separate from proposed behavior.

The repository contains a privacy-safe Claude contract spike, a Fixture-backed Core walking
skeleton, and an initial official-API Claude Code Local History collector. The collector stores
immutable local revisions, performs deterministic normalization and fact analysis, and writes
sanitized Console/JSON summaries.

## Current guarantees

- Read-only by default; no vendor settings are changed.
- No remote telemetry, error reporting, prompt upload, or code upload.
- Missing data is represented by availability and reason, never by a synthetic zero.
- Vendor data, canonical observations, and analytics are separate layers.
- The Core builds and tests without a Claude or Codex SDK.
- No internal Claude or Codex JSONL parser is used.

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

The first version supports `PURGE_ALL`; selective raw/session deletion and retention automation
remain unimplemented and are not implied by this command.

## Non-goals for the technical MVP

AXtory does not run agents, automatically group work, estimate ROI, assign an AI contribution
percentage, install hooks, enable OpenTelemetry, or provide a public connector plugin SPI.

## Contributing and security

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting code or fixtures. Never attach real
Claude or Codex sessions to an issue. Security reporting guidance is in
[`SECURITY.md`](SECURITY.md).

## License

AXtory is licensed under Apache License 2.0. Vendor products and SDKs remain separately
licensed and are not redistributed by this repository.
