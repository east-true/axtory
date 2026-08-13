<div align="center">

# AXtory

**Local-first, evidence-aware analytics for AI-assisted work.**

[![CI](https://github.com/east-true/axtory/actions/workflows/ci.yml/badge.svg)](https://github.com/east-true/axtory/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/typescript-7-3178C6.svg)](https://www.typescriptlang.org/)

</div>

<!-- Terminal capture of `report-usage` goes here. -->

AXtory reads what your AI coding tools already record — Claude Code sessions, Codex
threads, work-system activity — and turns them into a usage report you can actually check.
It is an observer, not an agent runner and not a prompt proxy.

Everything stays on your machine. There is no AXtory server, no telemetry, and no upload of
prompts or code. Raw evidence lives in immutable local revisions; sanitized projections and
analysis are kept in separate layers so you can always tell an observation from an
inference.

The point is not another dashboard of confident numbers. When AXtory cannot read something,
it says so — a missing value is `NOT_COLLECTED` or `PARTIAL_PAGINATION`, never a synthetic
zero.

## Features

- **Reads through official interfaces only** — the Claude Agent SDK, the Codex App Server, documented session stores, and vendor HTTPS APIs. No internal JSONL parsing, no settings changed behind your back.
- **Immutable, content-hashed revisions** — collecting the same unchanged session twice produces the same revision, so re-running a collector is safe.
- **Availability instead of zero** — bound hits, unreadable threads, and unsupported artifact types are reported as themselves, with the vendor's reason attached.
- **Privacy-safe by construction** — tool names collapse into categories; titles, descriptions, comments, URLs, repository names, and user identities never enter a persisted view.
- **Deletion and retention you can prove** — marker-guarded purge, selective raw/derived/session deletion with SQLite secure deletion, and classification-based retention that expires annotation text on the same terms as conversation content.
- **Observed vs. inferred, always separated** — semantic rule matches and fork lineage are recorded as `INFERRED` and are never promoted to verified fact.
- **Opt-in everything sensitive** — conversation-content analysis, live Hook/OTel collection, and Claude settings changes each require an explicit confirmation string.

## Status

AXtory is **pre-1.0 (v0.1.0-dev.0)** and under active development. It is not published to
npm — building from source is currently the only way to run it. The CLI surface, the
on-disk schema, and the report JSON may still change between versions.

## Sources

| Source                                   | Read through                                | Message/tool facts                 |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------- |
| Claude Code                              | Official Agent SDK                          | Available                          |
| Codex                                    | Official App Server (`thread/list`, `thread/read`) | Available                   |
| OpenCode                                 | JSON session list and export                | Available for the returned export  |
| Kimi Code                                | Documented session store, `wire.jsonl`      | Available for documented events    |
| Gemini CLI                               | Session list                                | `NOT_COLLECTED`; metadata only     |
| Cursor Agent                             | No non-interactive listing                  | `NOT_SUPPORTED`                    |
| Aider                                    | Explicit chat-history Markdown              | `NOT_SUPPORTED`; raw log only      |
| GitHub, GitLab, Jira, Linear             | Official HTTPS APIs                         | Metadata allowlist only            |
| Local Git                                | Local repository                            | No paths, diffs, messages, or authors |
| Claude Hook / OTel                       | Opt-in loopback receiver                    | Token, model, cost, latency        |

## Quick start

Requires **Node.js 24 or later**.

```sh
npm install
npm test
```

Run the synthetic end-to-end path twice — the second run produces the same content hash,
which is the idempotency guarantee in action:

```sh
npm run skeleton
npm run skeleton
```

To collect your real Claude Code history, install the official SDK separately (AXtory does
not bundle it) and run the collector:

```sh
npm install --no-save --omit=optional @anthropic-ai/claude-agent-sdk@0.3.220
npm run build
node dist/src/cli.js collect-claude --data-dir .local/axtory-claude
```

Then generate a report:

```sh
node dist/src/cli.js report-usage --data-dir .local/axtory-claude --source claude \
  --json-out .local/axtory-claude/usage-report.json
```

Collected prompts, responses, and tool payloads are sensitive local evidence stored with
user-only permissions. **Do not publish a `.local` data directory.**

Every other collector, report flag, and deletion mode is documented in the
[CLI reference](docs/cli.md).

## How it works

A collector reads a vendor's official interface and stores the returned view as an
immutable, content-hashed `RawRevision`. A normalizer derives canonical observations from
it; a projector turns those into the report. Raw evidence is never rewritten — only the
derived layer is recomputed, which is why `renormalize` can backfill a new field without
inventing a new revision.

```text
Claude · Codex · Gemini · OpenCode · Cursor · Aider · Kimi
GitHub · GitLab · Jira · Linear · Local Git · Hook/OTel
        │  official read interfaces only
        ▼
   RawRevision (immutable, content-hashed) ──► Blob Store (user-only permissions)
        │  normalizer
        ▼
   Observation (canonical, privacy-safe)
        │  projector
        ▼
   Usage report  ·  Analysis records (OBSERVED / INFERRED / INVALIDATED)
```

[`docs/architecture.md`](docs/architecture.md) covers the layers, the trust vocabulary, and
the storage contract. [`docs/privacy.md`](docs/privacy.md) covers exactly what is stored,
what is excluded, and how to delete it.

## Non-goals

AXtory does not run agents, automatically group work, estimate ROI, assign an AI
contribution percentage, automatically enable Hooks or OpenTelemetry, bundle a semantic
model provider, or provide a public connector plugin SPI.

The missing ROI numbers are a deliberate design decision, not a gap in the roadmap: each of
them needs a baseline for work that never happened, and a local observer cannot read that
alternative. [Why ROI numbers are missing](docs/cli.md#why-roi-numbers-are-missing) explains
what to do instead.

## Documentation

| Document                                                            | Contents                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [CLI reference](docs/cli.md)                                        | Every command, flag, and limitation, grouped by task               |
| [Privacy](docs/privacy.md)                                          | What is read, stored, excluded, exported, and how to delete it     |
| [Architecture](docs/architecture.md)                                | Boundaries, evidence pipeline, trust vocabulary, storage           |
| [Connector contracts](docs/research/connector-contracts.md)         | Claude/Codex official facts, local observations, and gaps          |
| [Additional AI contracts](docs/research/additional-ai-contracts.md) | Gemini/OpenCode/Cursor/Aider/Kimi read contracts and differences   |
| [Work-system contracts](docs/research/work-system-contracts.md)     | GitHub/GitLab/Jira/Linear APIs and the minimal collection contract |
| [Changelog](CHANGELOG.md)                                           | What shipped in each milestone, and what it did not establish      |
| [Document index](docs/README.md)                                    | Everything else: design decisions and internal audits              |

> User-facing documents are in English. The planning documents under `docs/internal/` and
> parts of the design and research documents are in Korean, the project's working baseline.

## Repository layout

- `src/connectors` — vendor read adapters (Claude, Codex, additional AI, work systems, Git)
- `src/core` — revisions, blob store, normalization, deletion, and retention
- `src/analysis` — usage reports, period comparison, rule matching, fork lineage, and Git/work correlation
- `src/projections` — sanitized session and work-artifact projections
- `src/live` — the opt-in Hook/OTel receiver and spool
- `fixtures/` — synthetic sessions used by the walking skeleton and tests
- `docs/` — user guides, vendor contract research, design decisions, and internal audits

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — in
particular, open an issue before starting substantial changes, and **never attach real
Claude or Codex sessions**, credentials, or private workspace content to an issue, test, or
pull request. Use synthetic fixtures instead.

To report a security vulnerability, follow [SECURITY.md](SECURITY.md) rather than opening a
public issue.

This project follows a [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Licensed under the [Apache License 2.0](LICENSE). Vendor products and SDKs remain
separately licensed and are not redistributed by this repository. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
