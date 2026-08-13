# Implementation plan

## Repository assessment

The initial workspace was not a Git repository. A prior uncommitted Python draft existed in a
sibling `openworklens` directory. It contained useful principles and partial storage code but no tests,
CLI, fixtures, connector, or end-to-end pipeline despite README claims. AXtory starts in a new
repository and does not modify that draft.

## Phase -3: Foundation

**Goal:** freeze product boundary, trust model, licensing, dependency, and versioning rules.

**Files:** root policy documents and `docs/design/foundation.md`.

**Completion:** Core has no Vendor runtime dependency, defaults are offline/read-only, and the
license boundary for the optional Claude SDK is explicit.

**Status:** implemented for the current scope. Apache-2.0 license, dependency boundary, threat
boundary, schema versioning, single-language decision, and non-goals are recorded.

## Phase -2: Claude contract spike

**Goal:** validate the installed Claude Code and official TypeScript history read API without
retaining content or identifiers.

**Files:** `src/connectors/claude/discovery.ts`, `history-api.ts`, `contract-spike.ts`,
`scripts/claude-contract-spike.ts`.

**Internal contracts:** injectable command runner and history reader used only for deterministic
tests. They are not a public connector SPI.

**Tests:** missing executable, malformed version, timeout, custom config root, absent SDK,
SDK errors, field fingerprints, message ordering/limits, sensitive-value exclusion.

**Completion:** a sanitized structural report is produced; unsupported capability is explicit;
no JSONL parser or Vendor configuration mutation exists.

**Status:** bounded local Spike completed with SDK 0.3.220 and CLI 2.1.226. Controlled resume,
compaction, active-session, custom-root SDK, worktree, and subagent cases remain open and are not
treated as verified.

## Phase -1: Core data model

Implement only execution/source/capability, collection run, source object/revision, raw
reference, normalized observation, analysis run/record, evidence, metric definition, output
policy, and export audit fields needed by the skeleton.

## Phase 0: Walking skeleton

One synthetic fixture must traverse fixture source -> raw blob -> revision -> deterministic
normalization -> session projection -> fact analysis -> output policy -> console and JSON.
Repeated collection adds a collection run but no duplicate revision or observation.

**Status:** implemented for `normal-session`. RawObservation, content-addressed blob, immutable
revision, deterministic observations, explicit SessionProjection, versioned fact analyzer,
Metric Catalog, Console policy, JSON sink, ExportRun, schema migration, and interrupted-run
reconciliation pass the end-to-end test. The remaining synthetic contract fixtures are Phase -2
follow-up work, not completed functionality.

## Phase 1-3

- Claude discovery: same-environment executable, version, config root, auth availability, SDK.
- Claude history: sessions, messages, tool blocks, revisions, incremental reads, deduplication.
- Fact analytics: counts, observed dates, cwd distribution when policy allows, tool occurrences,
  assertions, provenance, and availability.

## Later phases

Semantic analysis, Git, Hooks, OTel, Codex, and GitHub/GitLab/Jira/Linear work-system connectors
were implemented in later phases. Gemini CLI, OpenCode, Cursor, and Aider sources were implemented
in Phase 10 with capability-specific coverage. Phase 10.5 added latest-Revision usage analytics with
time/source scopes, session distributions, privacy-safe tool categories, Raw-evidence state,
same-database OTel facts, connected verification/annotation summaries, and opt-in semantic
integration. Cross-directory federation is not part of this local-DB report contract. AnalysisUnit
grouping, impact estimates, dashboards, and a published connector SPI remain deferred. Optional live
mode is introduced only with Hook/OTel and uses a bounded local spool.
