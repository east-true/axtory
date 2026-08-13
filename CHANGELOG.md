# Changelog

All notable changes to AXtory are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project intends to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) from 1.0.0 onward.

AXtory has not had a tagged release. Everything below is pre-1.0 development, grouped by
the delivery milestone it landed in. The CLI surface, on-disk schema, and report JSON may
still change without a deprecation period.

Each milestone lists what became usable and what it deliberately did not establish. The
full requirement-by-requirement evidence for each one is preserved in
[`docs/internal/audits/`](docs/internal/audits/).

## [Unreleased]

### 2026-08-10 — Usage analytics

- `report-usage` produces a Console and JSON usage report from collected sessions: session,
  message, and tool occurrence counts, per-session distribution (min/median/p90/max/mean),
  active UTC days, per-source aggregates, and a daily UTC timeline.
- Reports read one Revision per SourceObject — the latest one a completed collection run
  actually observed — so re-collecting is never counted as usage. Runs that failed are
  excluded from head selection.
- `--source` (repeatable), `--since`/`--until` (ISO-8601, half-open on source time),
  `--workspace-dir`, and `--branch` scope a report. Workspace and branch are matched by
  digest, so neither path nor branch name enters the report.
- `renormalize` re-reads retained raw evidence and recomputes derived observations in place
  without creating a revision. Dependent analysis records become `INVALIDATED`, which is
  distinct from `EVIDENCE_REMOVED`.
- `analyze-fork-lineage` records `FORKED_FROM` for Claude by vendor message identity rather
  than content resemblance, emitted only on an exact contiguous prefix with the correct
  direction. Derivation is `INFERRED`, not `OBSERVED`.
- `compare-usage` measures two independently bounded windows side by side; a value measured
  on only one side stays `UNKNOWN` instead of becoming a delta against an assumed zero.
- `list-annotations` reads annotation and verification note text back to stdout only — no
  file, no export run — because reports export counts, never user text.
- Annotations and verification notes carry their own `DataClassification` (schema v6/v8,
  default `PERSONAL_DATA`), so retention expires them on the same terms as conversation
  content. Retention clears an expired note but keeps the verification status.
- `annotate --baseline-minutes` (schema v7) stores a declared manual baseline as a number;
  the report totals only the classifications export policy permits and marks the rest
  `REDACTED`.
- The semantic opt-in is capped at 100 eligible revisions per invocation. Exceeding it
  prints runnable `--since`/`--until` window combinations that each stay under the cap.
- Not established: the report does not estimate work completion, AI contribution,
  causality, productivity, ROI, time saved, or impact. Counts from partial or compacted
  vendor views are a lower bound on the returned view.

### 2026-08-10 — Additional AI sources

- `collect-additional-ai` supports Gemini CLI, OpenCode, Cursor Agent, and Aider through
  the shared discovery, revision, projection, fact, and output path, without bundling any
  executable or changing any setting. Kimi Code was added afterwards by reading its
  documented session store directly.
- Capabilities are reported as they are, not normalized away: OpenCode yields structured
  messages and tool occurrences from its official JSON list/export; Gemini and Cursor are
  metadata-only (`NOT_COLLECTED`); Aider preserves the user-named Markdown history as raw
  with `UNKNOWN` structural coverage and `NOT_SUPPORTED` message facts.
- Child processes run without a shell, under cwd, timeout, and output-size bounds. List
  previews, paths, vendor IDs, and content are excluded from Console and JSON output.
- Not established: Gemini and Cursor metadata counts are not conversation analysis. Aider
  Markdown is a documented artifact but not a stable message schema. Content contracts for
  Gemini and Cursor rest on synthetic contract tests, since no credentialed session was
  available.

### 2026-08-10 — Work systems

- `collect-work-system` reads GitHub PRs/Actions/deployments, GitLab MRs/pipelines/
  deployments, Jira work items (enhanced JQL), and Linear work items (GraphQL) through
  official APIs into one `WorkArtifact` projection, with vendor pagination, auth, and
  status enums kept inside each adapter.
- HTTP boundary is HTTPS-only with redirects refused, a request timeout, a 16 MiB response
  cap, and body-free errors.
- Credentials come from named environment variables only; literal secret flags are
  rejected and secrets are excluded from output.
- The stored raw view is itself an allowlist — IDs, status, source timestamps, explicit
  commit links, and hashed environment/key identifiers. Titles, bodies, descriptions,
  comments, logs, user identities, URLs, and repository names are never stored.
- Commit identities are hashed the same way as Local Git, so an exact match links a change
  request to a Git snapshot as `OBSERVED`.
- Not established: no work-item-to-change-request link is inferred, and counts are the
  returned API view, not work completed, deployment effect, or AI contribution.

### 2026-08-09 — Codex

- `collect-codex` reads the official App Server using only `thread/list` and
  `thread/read(includeTurns: true)`.
- Because App Server initializes writable runtime state even for read methods, the whole
  process is isolated into a read-only SQLite backup inside a temporary private
  `CODEX_HOME`. Every list call forces `useStateDbOnly: true` so no rollout metadata repair
  scan is requested. The original state DB is never opened for writing.
- The stdio adapter can issue no client request outside the allowlist and refuses
  server-initiated requests.
- Active threads, source changes, compaction events, non-full turn views, and pagination
  bounds are preserved as explicit coverage rather than flattened into completeness.
- Not established: no active, fork, or parent link appeared in the real sample, so those
  paths rest on synthetic tests and official response fields. Compaction is recorded but
  pre-compaction history is not reconstructed. Thread history is not a token/cost authority,
  so those stay `NOT_COLLECTED`.

### 2026-08-09 — Semantic analysis, Local Git, Hook and OTel

- Selective deletion in three modes (`DELETE_RAW_ONLY`, `DELETE_RAW_AND_DERIVED`,
  `DELETE_SOURCE_SESSION`) plus classification-based retention, covering evidence state,
  unreferenced blobs, SQLite `secure_delete`, WAL checkpointing, and pending spool entries.
- `VerificationRecord` (multiple per result), `UserAnnotation` (non-destructive), and
  versioned `CollectionPolicy` persistence — schema v3.
- Opt-in rule semantic analyzer: narrow deterministic rules over retained conversation
  content, gated on explicit consent, emitting `INFERRED` assertions without copying source
  text. Local/remote model integration uses a tool-less structured-result adapter with
  strict schema and evidence validation; no provider is bundled or auto-configured.
- `collect-git` takes a read-only, metadata-minimal local snapshot — no paths, diffs,
  commit messages, or author identities — with an optional user-selected session link that
  is temporal correlation only.
- Opt-in loopback receiver for Claude HTTP Hooks and OTLP `http/json`, with Bearer auth,
  size and rate limits, a bounded crash-recoverable spool, content-bearing OTel gates
  turned off, exact 0600 settings backup, idempotent merge, and byte-equal rollback.
- Token, model, estimated cost, and latency arrive as content-free `OBSERVED` facts;
  estimated cost is namespaced separately from billing.
- Not established: rule matches and model findings are `INFERRED`, not technical
  verification. Git temporal correlation proves neither authorship nor causality. OTLP
  gRPC/protobuf and traces are not supported — AXtory writes the exporter config itself and
  specifies `http/json`, and controlled runs showed Claude Code emitting logs and metrics
  but zero traces.

### 2026-08-09 — Foundation and Claude Code history

- `collect-claude` reads sessions, messages, and tool invocations through the official
  Claude Agent SDK, with discovery of installation, version, data root, and auth as
  separate Availability facts. No internal JSONL parser exists in the source tree.
- The evidence pipeline is separated into layers: raw observation and content-addressed
  blob, immutable `SourceRevision`, deterministic `NormalizedObservation`,
  `SessionProjection`, versioned fact analyzer, and analysis records with evidence.
- Revisions are identified by content hash with a `lastModified` checkpoint, so
  re-collecting an unchanged view creates zero new revisions.
- Content identity and usage occurrence are separated — the same tool input used twice
  remains two occurrences.
- Time quality is explicit: a source with no timestamp yields `occurredAt = null` and
  `ORDER_ONLY` rather than the collector's own clock.
- Missing values are represented as themselves — `NOT_SUPPORTED`, `NOT_COLLECTED`, and
  `PARTIAL_SOURCE_CHANGED` with a reason — never as zero.
- Console and JSON sinks are sanitized and atomic, with an `ExportRun` audit record.
  Interrupted runs are reconciled on the next execution rather than assumed complete.
- Local files default to user-only permissions (0700/0600), with size limits, an allowlist,
  and a default collection policy.
- Not established: resume boundaries are not identifiable from the official history view,
  so no relation is created. Compaction preserves raw system content and partial coverage
  without claiming semantic relations. Tokens and cost are not estimated from history.

[Unreleased]: https://github.com/east-true/axtory/commits/main
