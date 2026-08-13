# Foundation decisions

Status: accepted for the contract spike, 2026-08-09

## Product boundary

AXtory observes tools the user already runs. It does not execute an agent, proxy prompts, choose
models, or require an AXtory account or server. The default workflow is an on-demand snapshot.
An optional live receiver may be added only for opt-in Hook or OTel collection.

## Invariants

1. Local-first and read-only are defaults, not deployment modes users must discover.
2. Raw source material, normalized observations, and analysis records are distinct types and
   storage boundaries.
3. `OBSERVED`, `CALCULATED`, `INFERRED`, and `ESTIMATED` describe derivation. Assertions and
   verification are independent axes.
4. Unavailable values carry an explicit status and reason. They are never coerced to zero.
5. Inferences and estimates require evidence, method/version, limitations, confidence band,
   and input revisions; an analyzer may return insufficient data.
6. Source revisions are immutable and content-hash idempotent. Content identity never removes
   a repeated usage occurrence.
7. Collected content and analyzer output are untrusted. Policies fail closed for unknown data
   classifications and every sink sanitizes independently.
8. Unsupported official interfaces remain explicit capability gaps. Connectors never silently
   parse undocumented vendor storage.
9. Users can export, retain, and delete raw and derived data. Removing evidence invalidates or
   removes dependent analysis according to policy.
10. No public connector SPI is defined until Claude and Codex demonstrate the same contract.

## Initial architecture decision

The contract spike and Core walking skeleton use TypeScript on Node.js 24.

- Claude's official TypeScript Agent SDK currently exposes the richest history contract,
  including subagent parent references.
- Codex's official App Server is language-neutral JSON-RPC and exposes thread list and read
  operations. Those methods are non-mutating, but App Server runtime initialization itself writes
  state; AXtory therefore starts it only against a temporary SQLite snapshot.
- Node's built-in SQLite keeps the offline Core free of required application dependencies.
- A single process is sufficient for the snapshot MVP and can later host an opt-in local
  receiver without introducing a service architecture.
- Core, CLI, storage, connectors, receivers, sinks, and tests remain in one language. A Go
  component is not introduced without a measured bottleneck that cannot be addressed in Node.

The Claude SDK is an optional, externally installed Vendor dependency. Core fixtures, storage,
normalization, analysis, and sinks must build and run when it is absent.

## Trust boundaries

```text
Vendor installation/history (untrusted, sensitive, read-only)
  -> connector quarantine and bounded structural/raw capture
  -> content-addressed raw blob + immutable revision metadata
  -> deterministic normalizer
  -> canonical observations
  -> tool-less fact analyzer
  -> output policy and sink sanitization
  -> console or local JSON
```

SQLite is not an encryption boundary. Filesystem permissions and full-disk encryption remain
deployment concerns. A later semantic analyzer receives only bounded, policy-approved input and
has no shell, filesystem, network, MCP, connector configuration, credentials, or sink access.

## Storage and concurrency

- SQLite stores metadata, revisions, normalized observations, analysis, policy, and export audit.
- Large content is stored once in a content-addressed blob directory.
- SQLite uses WAL, foreign keys, a busy timeout, and short transactions.
- Snapshot collection is single-writer. A future live receiver writes a bounded spool before DB
  ingestion so receiver latency and crash recovery are independent.
- A collection run is durable before source work. At the next startup, collection and analysis
  runs without a terminal record are marked failed with `INTERRUPTED` instead of disappearing.

## Versioning

- SQLite schema migrations are forward-only and numbered with `PRAGMA user_version`.
- Canonical records carry `schemaVersion`.
- Revisions carry `normalizerVersion`.
- Analyzer results carry method/version and input revision IDs.
- Reanalysis creates a new AnalysisRun; it never overwrites an earlier result.
