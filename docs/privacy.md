# Privacy and data handling

What AXtory reads, what it keeps, what it never records, and what you can delete. This is
the document to check before pointing AXtory at real sessions.

The short version: everything is local, sensitive content is stored but never exported, and
every path that touches your configuration or your conversation text requires you to ask
for it explicitly.

## What leaves your machine

Nothing.

There is no AXtory server, no account, no remote telemetry, no error reporting, and no
prompt or code upload. The core runs with no network access to anything but the vendor APIs
*you* configure for work-system collection — GitHub, GitLab, Jira, Linear — which are the
only outbound requests AXtory ever makes, and only when you run that command.

Live Hook and OTel collection binds to IPv4 loopback and never to an external interface.

## What is stored, and where

| Data                                                       | Location                                       | Permissions |
| ---------------------------------------------------------- | ---------------------------------------------- | ----------- |
| Prompts, responses, tool payloads, conversation exports     | Blob Store, SHA-256 content-addressed files    | user-only (0600) |
| Sessions, revisions, observations, analysis records, policy | SQLite database in the data directory          | user-only (0600) |
| Live Hook/OTel envelopes awaiting ingestion                 | Bounded spool in the data directory            | user-only (0600) |
| Data directory itself                                       | The `--data-dir` you name                      | user-only (0700) |

A data directory holds raw vendor evidence. **Do not publish one, attach one to an issue, or
commit one.** The repository's `.gitignore` covers `.local`, but the guarantee is yours to
keep if you point `--data-dir` elsewhere.

## What is never recorded

These exclusions are enforced in the collector, not in the output formatter — the values do
not exist in the stored view at all.

**Work systems (GitHub, GitLab, Jira, Linear).** The raw view is an allowlist, not the
vendor's full response. Titles, bodies, descriptions, comments, logs, user identities, URLs,
and repository names are excluded. What remains: IDs, status, source timestamps, explicit
commit links, and hashed environment/key identifiers.

**Local Git.** Paths, diffs, commit messages, and author identities are excluded. Commit
identities are SHA-256 hashed.

**Workspace and branch context.** Claude and Codex sessions record a workspace, but only the
digest of the resolved absolute path and the digest of the branch name are stored. Neither
the path nor the branch name enters a report. Codex exposes `gitInfo.originUrl`; AXtory
deliberately does not collect it — it identifies a remote repository rather than a local
path, Claude has no equivalent field, and no product requirement needs the distinction.

**Tool names.** Custom MCP and dynamic extension names are collapsed into a privacy-safe
allowlist of categories, so a report cannot leak the names of your internal tooling.

**Additional AI CLIs.** Session list previews, filesystem paths, and vendor IDs are
discarded at collection. Child processes run without a shell under cwd, timeout, and
output-size bounds, and errors are content-free.

**OTel.** Content-bearing gates are turned off when AXtory writes the exporter
configuration: prompts, tool details, tool content, raw API bodies, and account/session
metric IDs are all disabled.

## What reports export

A usage report exports aggregate counts, ratios, availability, coverage, and evidence
status. It does **not** export:

- conversation content, message text, or tool payloads
- vendor identifiers, session IDs, or paths
- custom extension names
- annotation assertions or verification note text

Annotation and verification text is available only through `list-annotations`, which prints
to stdout, writes no file, and records no export run.

Every export writes an `ExportRun` audit record with destination, policy version, record
count, classification, status, and digest.

## Data classification

Every stored value carries one of: `PUBLIC_METADATA`, `LOCAL_METADATA`,
`IDENTIFYING_METADATA`, `CONVERSATION_CONTENT`, `SOURCE_CONTENT`, `TOOL_CONTENT`, `SECRET`,
`PERSONAL_DATA`.

The collection policy controls `capture`, `persist`, `analyze`, `export`, and `retention`
per classification. **An unknown classification fails closed.**

This is why your own annotations are classified too. `annotate` defaults to
`PERSONAL_DATA`, so a declared baseline stays local and a report shows `REDACTED` with the
count of withheld records instead of the number. It expires under retention on the same
terms as conversation content.

## Opt-in boundaries

Four things AXtory will not do unless you ask, each with a distinct gate:

| Action                                    | Gate                                                      |
| ----------------------------------------- | --------------------------------------------------------- |
| Read retained conversation content        | `--allow-conversation-content` on that specific invocation |
| Change Claude settings for live collection | `--confirm APPLY_CLAUDE_LIVE_CONFIG`, after `plan-live` shows the diff |
| Restore Claude settings                    | `--confirm ROLLBACK_CLAUDE_LIVE_CONFIG` with the exact backup path |
| Delete data                                | An exact confirmation string matching the mode (`PURGE_ALL`, `DELETE_RAW_ONLY`, …) |

Hooks and OpenTelemetry are never enabled automatically. `plan-live` shows what would
change before anything is written; the change itself merges into existing keys, is
idempotent, and writes a 0600 exact backup whose path is printed for you to keep. Rollback
restores it byte-for-byte.

Semantic analysis is off by default, capped at 100 eligible revisions per invocation, and
its output is `INFERRED` — never presented as verification.

## Deletion and retention

```sh
# everything
node dist/src/cli.js purge --data-dir .local/axtory --confirm PURGE_ALL

# raw evidence only, keeping derived counts
node dist/src/cli.js delete --data-dir .local/axtory \
  --mode DELETE_RAW_ONLY --revision-id revision_... --confirm DELETE_RAW_ONLY

# automatic expiry by classification
node dist/src/cli.js retain --data-dir .local/axtory \
  --classification CONVERSATION_CONTENT --days 30
```

Deletion is not best-effort. It applies SQLite `secure_delete` and WAL checkpointing,
removes blobs that no longer have a reference, updates dependent evidence state, and covers
matching pending entries in the live spool.

Deleting raw evidence does not silently improve a report: affected records are marked
`EVIDENCE_REMOVED` and the section becomes `PARTIAL`. Derived counts may survive, but the
report says the evidence behind them is gone.

`DELETE_RAW_AND_DERIVED` and `DELETE_SOURCE_SESSION` follow the same exact-confirmation
rule. Full command detail is in [`cli.md`](cli.md#deletion-and-retention).

## Credentials

Work-system tokens are read from named environment variables only —
`GITHUB_TOKEN`, `GITLAB_TOKEN`, `JIRA_EMAIL`/`JIRA_API_TOKEN`, `LINEAR_API_KEY`, or
whatever you select with `--token-env`/`--email-env`. **Literal credential flags are
rejected**, so a token cannot end up in your shell history through AXtory.

Requests are HTTPS-only, refuse redirects, time out, cap responses at 16 MiB, and produce
body-free errors so a failure cannot echo a response containing a secret.

The live receiver generates a Bearer token at startup and validates body size, rate, and
content type before anything reaches the spool.

## Reporting a problem

If you find a way to make AXtory record, export, or transmit something this document says
it does not, please follow [`../SECURITY.md`](../SECURITY.md) rather than opening a public
issue.

When reporting anything, never attach real sessions, tokens, or private workspace content.
Use the synthetic fixtures in [`../fixtures/`](../fixtures/).
