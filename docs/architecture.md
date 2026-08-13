# Architecture

How AXtory turns a vendor's official read interface into a report you can check. This is
the orientation document; [`design/system-design.md`](design/system-design.md) is the full
design baseline, and [`privacy.md`](privacy.md) covers what is and is not stored.

## Boundaries

```text
┌──────────────── Your existing workflow ─────────────────┐
│ Claude Code    Codex    other AI CLIs    work systems   │
└───────────────┬──────────────────────────────────────────┘
                │ official read API / opt-in event channel
┌───────────────▼──────── AXtory ──────────────────────────┐
│ Discovery → Capability → Collection → Raw/Revision       │
│           → Normalization → Projection                   │
│           → Analysis → Output policy → Sink              │
└───────────────┬──────────────────────────────────────────┘
                │ local files only
        SQLite  ·  Blob Store  ·  Spool
```

AXtory does not run agents, choose models, proxy prompts, or log in on your behalf. It runs
when you run it, reads what the vendor already exposes, and exits.

## The pipeline

```text
Vendor source or fixture
→ Discovery / CapabilityAssessment
→ CollectionRun STARTED
→ RawObservation + content-addressed blob
→ SourceObject / immutable SourceRevision
→ deterministic NormalizedObservation
→ SessionProjection
→ versioned fact analyzer
→ AnalysisRun / AnalysisRecord / Evidence
→ OutputPolicy → Console or JSON sink → ExportRun
→ CollectionRun COMPLETED
```

If a process is interrupted before a terminal state, the next run reconciles that
`CollectionRun` or `AnalysisRun` as `FAILED`/`INTERRUPTED`. Silence on stdout is never read
as success.

The live path is `HTTP → Spool STARTED/RECEIVED → PROCESSING → Raw/Revision/Normalized →
Analysis → COMPLETED`, reconciled the same way.

## Layer separation

The four layers exist so that a vendor's payload, a canonical observation, and a
conclusion can never be mistaken for one another.

| Layer                  | Holds                                                       | Rule                                                     |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------- |
| Raw                    | The vendor view exactly as returned, in a content-addressed blob | Never rewritten                                     |
| Revision               | An immutable `SourceRevision` identified by content hash     | Same hash → no new revision                              |
| Normalized             | Canonical observations: `EVENT`, `SNAPSHOT`, `CONTENT`, `METRIC`, `RELATION` | Structure only — never intent, requirement, or goal completion |
| Analysis               | Metrics, assertions, findings, relations, with evidence      | Carries a derivation and can be invalidated              |

Because a revision is identified by the hash of the raw view, it stands for *a state of the
source*. A normalizer change is not a source change — which is why `renormalize` recomputes
the derived layer in place instead of inventing a new revision. Raw immutability means the
original is not modified; it does not forbid recomputing what was derived from it.

## Trust vocabulary

Three independent axes, deliberately not collapsed into a single confidence score:

- **Derivation** — `OBSERVED`, `CALCULATED`, `INFERRED`, `ESTIMATED`.
- **Provenance** — `OFFICIAL_API`, `DOCUMENTED_STORAGE`, `LOCAL_FILE`, `EXTERNAL_API`,
  `USER_PROVIDED`, `HEURISTIC`. An `OBSERVED` value can still be wrong if its provenance or
  source integrity is weak.
- **Verification** — several `VerificationRecord`s can attach to one result, typed
  `SOURCE_INTEGRITY`, `TECHNICAL`, `HUMAN_ACCEPTANCE`, `WORKFLOW`, `DEPLOYMENT`, or
  `PRODUCTION_OUTCOME`. Passing a technical check and being accepted by a human are not
  substitutes for each other.

This is what lets Codex's declared `forkedFromId` and Claude's fork — recovered from vendor
message identity — coexist without the second being presented as the first.
[`cli.md`](cli.md#fork-lineage) has that case in detail.

## Availability instead of zero

Every count can be absent, and absence has a reason. `NOT_COLLECTED`, `NOT_SUPPORTED`,
`SOURCE_UNAVAILABLE`, `PARTIAL_PAGINATION`, `PARTIAL_SOURCE_CHANGED`,
`PARTIAL_UNREADABLE_THREAD`, `PARTIAL_UNSETTLED_TURN`, and `EVIDENCE_REMOVED` are values in
the report, not error messages that get swallowed.

The reason this matters: a synthetic zero and a real zero are the same number, and once
they are mixed no downstream reader can separate them again.

## Time model

Four timestamps, never substituted for one another:

- `occurredAt` — when the source says it happened
- `observedAt` — when the collector read it
- `sourceModifiedAt` — when the source object last changed
- `receivedAt` — when a live event arrived

Quality is recorded as `EXACT`, `SOURCE_REPORTED`, `RECEIVER_TIMESTAMP`,
`FILE_MODIFIED_APPROXIMATION`, `ORDER_ONLY`, or `UNKNOWN`. When `occurredAt` is unknown, the
collector's clock does not stand in for it.

## Content identity vs. usage occurrence

The same content reappears across resume, fork, and subagent paths. Content analysis may
deduplicate by hash identity, but each actual use stays its own occurrence — blob-level
deduplication is never applied to usage counts. Two identical tool inputs are two tool
invocations.

## Storage

- **SQLite** — metadata, source objects, revisions, raw references, normalized
  observations, analysis runs and records, policy, and export runs. WAL, foreign keys, busy
  timeout, short `BEGIN IMMEDIATE` write transactions, `PRAGMA user_version` forward
  migrations, user-only permissions, single writer.
- **Blob Store** — prompts, responses, tool output, and diffs stored once as SHA-256
  content-addressed files, so large payloads are never repeated across rows.
- **Spool** — used only while receiving Hook/OTel traffic. State history is append-only and
  replaced atomically, bounded by both item and byte limits. After ingestion, duplicates
  are removed by idempotency key and immutable revision, terminal envelopes are deleted, and
  the database becomes the long-term evidence owner.

One data directory is one SQLite database and one boundary. Repeated `--source` selects
among sources collected into *that* database; AXtory does not federate or merge separate
data directories.

## Analysis security

Collected content is treated as untrusted input, including by AXtory's own analyzers:

```text
Untrusted content
→ quarantine → redaction / size limit
→ tool-less analyzer → structured JSON
→ strict schema validation → evidence existence validation
→ AnalysisRecord
```

A semantic model gets no shell, filesystem, MCP, network, connector configuration,
credential, or output-sink access. Unknown fields, enums, lengths, and evidence IDs are all
validated before a record is written.

## Module layout

```text
core/          model, revision, availability, policy, storage, deletion, renormalize
connectors/    claude · codex · additional-ai · work-systems · git
projections/   session and work-artifact read models
analysis/      metric catalog, fact analyzer, usage report, comparison,
               semantic analyzer, fork lineage, Git/work correlation, OTel facts
live/          opt-in Hook/OTLP receiver, bounded spool, ingestion, settings backup
fixtures/      synthetic vendor contract data
```

This is internal module structure, **not a public connector SPI**. The commonalities found
across the Claude and Codex implementations are documented as a candidate only — see
[`design/connector-spi-candidate.md`](design/connector-spi-candidate.md) — and no connector
function or vendor DTO is published as a stability contract.

## Deployment posture

Running the core requires no AXtory account, no central server, and no remote AI API. Only
built-in connectors run; community connectors are a future process-isolation candidate and
are never auto-discovered or auto-executed. No microservices, no message broker, one
language.
